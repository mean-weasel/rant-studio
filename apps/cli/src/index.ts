import { lstat, readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { RantClient, RantApiError } from '../../../packages/api/src/index.ts';
import {
  parseProposalJson,
  planningContext,
  readProposalSubmission,
} from './semantic-planning.ts';

type CliContext = {
  baseUrl: string;
  credential?: string;
  readSecret?: (input: { prompt: string; stdin: boolean }) => Promise<string>;
  write: (line: string) => void;
};

type ProviderName = 'groq' | 'openai';

type ProviderSnapshot = {
  activeProvider: 'deterministic' | ProviderName;
  activeSource: 'deterministic' | 'environment' | 'keychain';
  providers: Array<{
    configured: boolean;
    provider: ProviderName;
    selected: boolean;
    source: 'environment' | 'keychain' | null;
    status: 'configured' | 'invalid' | 'missing' | 'valid';
  }>;
};

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function providerName(value: string | undefined): ProviderName {
  if (value === 'openai' || value === 'groq') return value;
  throw new Error('Provider must be openai or groq');
}

function providerOutput(
  snapshot: ProviderSnapshot,
  jsonOutput: boolean,
): string {
  if (jsonOutput) return JSON.stringify(snapshot);
  return [
    `Active transcription: ${snapshot.activeProvider} (${snapshot.activeSource})`,
    ...snapshot.providers.map(
      (provider) =>
        `${provider.provider}: ${provider.status}` +
        `${provider.selected ? ' · selected' : ''}` +
        `${provider.source ? ` · ${provider.source}` : ''}`,
    ),
  ].join('\n');
}

async function providerRequest(
  context: CliContext,
  path: string,
  init: RequestInit = {},
): Promise<ProviderSnapshot> {
  const response = await fetch(`${context.baseUrl.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      ...(context.credential
        ? { authorization: `Bearer ${context.credential}` }
        : {}),
      'content-type': 'application/json',
      ...init.headers,
    },
  });
  const payload = (await response.json()) as
    ProviderSnapshot | { error?: { code?: string; message?: string } };
  if (!response.ok) {
    const error = 'error' in payload ? payload.error : undefined;
    throw new RantApiError(
      error?.code ?? 'API_ERROR',
      error?.message ?? `Provider request failed with HTTP ${response.status}`,
      response.status,
    );
  }
  return payload as ProviderSnapshot;
}

const help = `Rant Studio agent CLI

Connection:
  Set RANT_STUDIO_URL to the loopback value printed by npm run service.
  Local owner commands need no credential. External agents must also set the
  printed RANT_STUDIO_CREDENTIAL; agent credentials cannot perform approvals.

Read shared state:
  rant project get|intake|editorial|ledger|assets|activity|media <project>

Agent work:
  rant agent attach <project>
  rant task claim <project> <task> --session <session>
  rant task transition <project> <task> --revision <n> --status <state>
       --idempotency <key> [--summary <text>]
  rant proposal context <project> <task>
  rant proposal submit <project> <task> --revision <n>
       --transcript <revision-id> (--shots-file <json-file> | --shots-json <json>)
  rant asset attach <project> --revision <n> --shots <id,id>
       --file <png-or-mp4> [--task <task>]
  rant asset recommend <project> --revision <n> --shot <id>
       --asset <id> --reason <text>

Transcription providers:
  rant provider list [--json]
  rant provider configure openai|groq [--stdin] [--no-select] [--json]
  rant provider test openai|groq [--json]
  rant provider select openai|groq [--json]
  rant provider remove openai|groq [--json]

  Configure reads the key from a hidden prompt. --stdin reads it from standard
  input for automation. Raw keys are never accepted as command arguments.
  Local owner commands may change providers. Agent credentials may only list
  provider readiness.

Recovery:
  Refresh the project and retry with the current revision after REVISION_CONFLICT.
  Reattach and reclaim after DETACHED_AGENT or an interrupted lease.
  Only the browser-side human may accept proposals, select visuals, or export.`;

export async function runCli(
  args: string[],
  context: CliContext,
): Promise<number> {
  const client = new RantClient({
    baseUrl: context.baseUrl,
    credential: context.credential,
  });
  try {
    if (args.length === 0 || args[0] === 'help' || args[0] === '--help') {
      context.write(help);
      return 0;
    }
    if (args[0] === 'provider' && args[1] === 'list') {
      const snapshot = await providerRequest(
        context,
        '/v1/transcription-providers',
      );
      context.write(providerOutput(snapshot, args.includes('--json')));
      return 0;
    }
    if (args[0] === 'provider' && args[1] === 'configure') {
      const provider = providerName(args[2]);
      if (
        args.includes('--key') ||
        args.includes('--secret') ||
        args.includes('--credential')
      ) {
        throw new Error(
          'Raw provider credentials are not accepted as command arguments',
        );
      }
      if (!context.readSecret) {
        throw new Error('Secure credential input is unavailable');
      }
      const credential = await context.readSecret({
        prompt: `${provider} API key: `,
        stdin: args.includes('--stdin'),
      });
      if (!credential.trim())
        throw new Error('Provider credential is required');
      const snapshot = await providerRequest(
        context,
        `/v1/transcription-providers/${provider}/credential`,
        {
          body: JSON.stringify({
            credential,
            select: !args.includes('--no-select'),
          }),
          method: 'PUT',
        },
      );
      context.write(providerOutput(snapshot, args.includes('--json')));
      return 0;
    }
    if (
      args[0] === 'provider' &&
      (args[1] === 'test' || args[1] === 'select' || args[1] === 'remove')
    ) {
      const provider = providerName(args[2]);
      const action = args[1];
      const snapshot = await providerRequest(
        context,
        `/v1/transcription-providers/${provider}/${
          action === 'remove' ? 'credential' : action
        }`,
        { method: action === 'remove' ? 'DELETE' : 'POST' },
      );
      context.write(providerOutput(snapshot, args.includes('--json')));
      return 0;
    }
    if (args[0] === 'project' && args[1] === 'get' && args[2]) {
      context.write(JSON.stringify(await client.getProject(args[2])));
      return 0;
    }
    if (args[0] === 'project' && args[1] === 'intake' && args[2]) {
      context.write(JSON.stringify(await client.getIntake(args[2])));
      return 0;
    }
    if (args[0] === 'project' && args[1] === 'editorial' && args[2]) {
      context.write(JSON.stringify(await client.getEditorial(args[2])));
      return 0;
    }
    if (args[0] === 'project' && args[1] === 'ledger' && args[2]) {
      context.write(JSON.stringify(await client.getLedger(args[2])));
      return 0;
    }
    if (args[0] === 'project' && args[1] === 'activity' && args[2]) {
      context.write(
        JSON.stringify(
          await client.getActivity(args[2], {
            status: option(args, '--status') as never,
          }),
        ),
      );
      return 0;
    }
    if (args[0] === 'project' && args[1] === 'assets' && args[2]) {
      context.write(JSON.stringify(await client.getAssets(args[2])));
      return 0;
    }
    if (args[0] === 'project' && args[1] === 'media' && args[2]) {
      context.write(JSON.stringify(await client.getMedia(args[2])));
      return 0;
    }
    if (args[0] === 'agent' && args[1] === 'attach' && args[2]) {
      context.write(JSON.stringify(await client.attachAgent(args[2])));
      return 0;
    }
    if (args[0] === 'task' && args[1] === 'claim' && args[2] && args[3]) {
      const sessionId = option(args, '--session');
      if (!sessionId) throw new Error('task claim requires --session');
      context.write(
        JSON.stringify(await client.claimTask(args[2], args[3], { sessionId })),
      );
      return 0;
    }
    if (args[0] === 'task' && args[1] === 'transition' && args[2] && args[3]) {
      const revision = Number(option(args, '--revision'));
      const status = option(args, '--status');
      const idempotencyKey = option(args, '--idempotency');
      if (!Number.isInteger(revision) || !status || !idempotencyKey) {
        throw new Error(
          'task transition requires --revision, --status, and --idempotency',
        );
      }
      context.write(
        JSON.stringify(
          await client.transitionTask(args[2], args[3], {
            expectedProjectRevision: revision,
            idempotencyKey,
            status: status as never,
            summary: option(args, '--summary'),
          }),
        ),
      );
      return 0;
    }
    if (args[0] === 'asset' && args[1] === 'attach' && args[2]) {
      const revision = Number(option(args, '--revision'));
      const shots = option(args, '--shots');
      const filePath = option(args, '--file');
      if (!Number.isInteger(revision) || !shots || !filePath) {
        throw new Error(
          'asset attach requires --revision, --shots, and --file',
        );
      }
      const fileStat = await lstat(filePath);
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        throw new Error(
          'asset attach --file must be a regular file, not a symbolic link',
        );
      }
      const extension = extname(filePath).toLowerCase();
      if (extension !== '.png' && extension !== '.mp4') {
        throw new Error('asset attach supports only .png and .mp4 files');
      }
      const bytes = await readFile(filePath);
      context.write(
        JSON.stringify(
          await client.uploadVisualCandidate(args[2], {
            bytesBase64: bytes.toString('base64'),
            expectedRevision: revision,
            mimeType: extension === '.mp4' ? 'video/mp4' : 'image/png',
            originalName: basename(filePath),
            shotIds: shots.split(',').filter(Boolean),
            taskId: option(args, '--task'),
          }),
        ),
      );
      return 0;
    }
    if (args[0] === 'asset' && args[1] === 'recommend' && args[2]) {
      const revision = Number(option(args, '--revision'));
      const shotId = option(args, '--shot');
      const assetId = option(args, '--asset');
      const reason = option(args, '--reason');
      if (!Number.isInteger(revision) || !shotId || !assetId || !reason) {
        throw new Error(
          'asset recommend requires --revision, --shot, --asset, and --reason',
        );
      }
      context.write(
        JSON.stringify(
          await client.recommendVisual(args[2], {
            assetId,
            expectedRevision: revision,
            reason,
            shotId,
          }),
        ),
      );
      return 0;
    }
    if (args[0] === 'proposal' && args[1] === 'context' && args[2] && args[3]) {
      const [editorial, activity] = await Promise.all([
        client.getEditorial(args[2]),
        client.getActivity(args[2]),
      ]);
      context.write(
        JSON.stringify(
          planningContext({
            activity,
            editorial,
            projectId: args[2],
            taskId: args[3],
          }),
        ),
      );
      return 0;
    }
    if (args[0] === 'proposal' && args[1] === 'submit' && args[2] && args[3]) {
      const revision = Number(option(args, '--revision'));
      const transcript = option(args, '--transcript');
      const shotsJson = option(args, '--shots-json');
      const shotsFile = option(args, '--shots-file');
      if (
        !Number.isInteger(revision) ||
        !transcript ||
        Boolean(shotsJson) === Boolean(shotsFile)
      ) {
        throw new Error(
          'proposal submit requires --revision, --transcript, and exactly one of --shots-file or --shots-json',
        );
      }
      const submission = shotsFile
        ? await readProposalSubmission(shotsFile)
        : parseProposalJson(shotsJson!);
      context.write(
        JSON.stringify(
          await client.submitShotProposal(args[2], args[3], {
            baseProjectRevision: revision,
            baseTranscriptRevisionId: transcript,
            ...submission,
          }),
        ),
      );
      return 0;
    }
    if (args[0] === 'project' && args[1] === 'note' && args[2]) {
      const revision = Number(option(args, '--revision'));
      const note = option(args, '--text');
      if (!Number.isInteger(revision) || !note) {
        throw new Error('project note requires --revision and --text');
      }
      context.write(
        JSON.stringify(
          await client.mutateProject(args[2], {
            expectedRevision: revision,
            operation: 'add_note',
            payload: { note },
          }),
        ),
      );
      return 0;
    }
    context.write(help);
    return 2;
  } catch (error) {
    if (error instanceof RantApiError) {
      context.write(
        JSON.stringify({ error: { code: error.code, message: error.message } }),
      );
      return 1;
    }
    context.write(
      JSON.stringify({
        error: {
          code: error instanceof SyntaxError ? 'MALFORMED_INPUT' : 'CLI_INPUT',
          message: error instanceof Error ? error.message : 'Invalid CLI input',
          recovery:
            'Run rant help, refresh shared state, and retry with explicit project, revision, and target IDs.',
        },
      }),
    );
    return 2;
  }
}
