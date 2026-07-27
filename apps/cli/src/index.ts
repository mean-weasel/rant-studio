import { lstat, readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { RantClient, RantApiError } from '../../../packages/api/src/index.ts';

type CliContext = {
  baseUrl: string;
  credential: string;
  write: (line: string) => void;
};

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const help = `Rant Studio agent CLI

Connection:
  Set RANT_STUDIO_URL and RANT_STUDIO_CREDENTIAL to the loopback values
  printed by npm run service. Agent credentials cannot perform human approvals.

Read shared state:
  rant project get|intake|editorial|ledger|assets|activity|media <project>

Agent work:
  rant agent attach <project>
  rant task claim <project> <task> --session <session>
  rant task transition <project> <task> --revision <n> --status <state>
       --idempotency <key> [--summary <text>]
  rant proposal submit <project> <task> --revision <n>
       --transcript <revision-id> --shots-json <json>
  rant proposal submit-chronological <project> <task> --shots <count>
  rant asset attach <project> --revision <n> --shots <id,id>
       --file <png-or-mp4> [--task <task>]
  rant asset recommend <project> --revision <n> --shot <id>
       --asset <id> --reason <text>

Recovery:
  Refresh the project and retry with the current revision after REVISION_CONFLICT.
  Reattach and reclaim after DETACHED_AGENT or an interrupted lease.
  Only the browser-side human may accept proposals, select visuals, or export.`;

export async function runCli(args: string[], context: CliContext): Promise<number> {
  const client = new RantClient({
    baseUrl: context.baseUrl,
    credential: context.credential,
  });
  try {
    if (args.length === 0 || args[0] === 'help' || args[0] === '--help') {
      context.write(help);
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
        JSON.stringify(
          await client.claimTask(args[2], args[3], { sessionId }),
        ),
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
        throw new Error('asset attach requires --revision, --shots, and --file');
      }
      const fileStat = await lstat(filePath);
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        throw new Error('asset attach --file must be a regular file, not a symbolic link');
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
    if (args[0] === 'proposal' && args[1] === 'submit' && args[2] && args[3]) {
      const revision = Number(option(args, '--revision'));
      const transcript = option(args, '--transcript');
      const shotsJson = option(args, '--shots-json');
      if (!Number.isInteger(revision) || !transcript || !shotsJson) {
        throw new Error(
          'proposal submit requires --revision, --transcript, and --shots-json',
        );
      }
      const shots = JSON.parse(shotsJson) as Array<{
        endWordOrdinal: number;
        rationale: string;
        startWordOrdinal: number;
        theme: string;
      }>;
      context.write(
        JSON.stringify(
          await client.submitShotProposal(args[2], args[3], {
            baseProjectRevision: revision,
            baseTranscriptRevisionId: transcript,
            shots,
          }),
        ),
      );
      return 0;
    }
    if (
      args[0] === 'proposal' &&
      args[1] === 'submit-chronological' &&
      args[2] &&
      args[3]
    ) {
      const shotCount = Number(option(args, '--shots'));
      if (!Number.isInteger(shotCount) || shotCount < 1) {
        throw new Error('proposal submit-chronological requires --shots <positive-count>');
      }
      const editorial = await client.getEditorial(args[2]);
      const words = editorial.effectiveTranscript.words;
      const count = Math.min(shotCount, words.length);
      if (count < 1) throw new Error('the project transcript has no words');
      const shots = Array.from({ length: count }, (_, index) => ({
        endWordOrdinal:
          index === count - 1
            ? words.length - 1
            : Math.floor(((index + 1) * words.length) / count) - 1,
        rationale: `Keep chronological beat ${index + 1} together.`,
        startWordOrdinal: Math.floor((index * words.length) / count),
        theme: `Beat ${index + 1}`,
      }));
      context.write(
        JSON.stringify(
          await client.submitShotProposal(args[2], args[3], {
            baseProjectRevision: editorial.revision,
            baseTranscriptRevisionId: editorial.effectiveTranscript.id,
            shots,
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
      context.write(JSON.stringify({ error: { code: error.code, message: error.message } }));
      return 1;
    }
    context.write(
      JSON.stringify({
        error: {
          code: error instanceof SyntaxError ? 'MALFORMED_INPUT' : 'CLI_INPUT',
          message: error instanceof Error ? error.message : 'Invalid CLI input',
          recovery: 'Run rant help, refresh shared state, and retry with explicit project, revision, and target IDs.',
        },
      }),
    );
    return 2;
  }
}
