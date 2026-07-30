import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '../../apps/cli/src/index.ts';
import { TranscriptionCredentialRegistry } from '../../apps/service/src/credential-store.ts';
import { openProviderMetadataStore } from '../../apps/service/src/provider-metadata.ts';
import { openProjectStore } from '../../apps/service/src/store.ts';
import { startLocalService } from '../../apps/service/src/server.ts';
import { RantClient } from '../../packages/api/src/index.ts';
import { MemorySecretStore } from '../helpers/memory-secret-store.ts';

test('CLI help and local errors explain authority, revisions, targets, and recovery', async () => {
  const output: string[] = [];
  const context = {
    baseUrl: 'http://127.0.0.1:1',
    credential: 'unused',
    write: (line: string) => output.push(line),
  };
  assert.equal(await runCli(['help'], context), 0);
  assert.match(output.at(-1)!, /Only the browser-side human/);
  assert.match(output.at(-1)!, /REVISION_CONFLICT/);
  assert.match(output.at(-1)!, /--shots <id,id>/);
  assert.equal(
    await runCli(
      [
        'proposal',
        'submit',
        'project-id',
        'task-id',
        '--revision',
        '4',
        '--transcript',
        'transcript-id',
        '--shots-json',
        '{not-json',
      ],
      context,
    ),
    2,
  );
  assert.deepEqual(JSON.parse(output.at(-1)!).error.code, 'MALFORMED_INPUT');
  assert.match(
    JSON.parse(output.at(-1)!).error.recovery,
    /project, revision, and target/,
  );
});

test('CLI shares redacted provider readiness while owner-only commands use secure input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rant-studio-cli-provider-'));
  const databasePath = join(directory, 'project.db');
  const store = openProjectStore(databasePath);
  const metadata = openProviderMetadataStore(databasePath);
  const secrets = new MemorySecretStore();
  const validationAuthorization: Array<string | null> = [];
  const registry = new TranscriptionCredentialRegistry({
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      validationAuthorization.push(
        new Headers(init?.headers).get('authorization'),
      );
      return new Response('{"data":[]}', { status: 200 });
    }) as typeof fetch,
    metadata,
    secretStore: secrets,
  });
  const agentCredential = store.issueCredential({
    role: 'agent',
    scopes: ['provider:read'],
  });
  const service = await startLocalService({
    credentialRegistry: registry,
    port: 0,
    store,
  });
  const output: string[] = [];
  const inputCalls: Array<{ prompt: string; stdin: boolean }> = [];
  let nextSecret = 'CLI-CANARY-never-print';
  const humanContext = {
    baseUrl: service.url,
    readSecret: async (input: { prompt: string; stdin: boolean }) => {
      inputCalls.push(input);
      return nextSecret;
    },
    write: (line: string) => output.push(line),
  };

  try {
    assert.equal(
      await runCli(
        ['provider', 'configure', 'openai', '--stdin', '--json'],
        humanContext,
      ),
      0,
    );
    assert.deepEqual(inputCalls, [{ prompt: 'openai API key: ', stdin: true }]);
    assert.equal(output.at(-1)!.includes(nextSecret), false);
    assert.equal(JSON.parse(output.at(-1)!).activeProvider, 'openai');

    const agentOutput: string[] = [];
    const agentContext = {
      baseUrl: service.url,
      credential: agentCredential.token,
      readSecret: async () => 'agent-must-not-save',
      write: (line: string) => agentOutput.push(line),
    };
    assert.equal(await runCli(['provider', 'list', '--json'], agentContext), 0);
    assert.equal(agentOutput.at(-1)!.includes(nextSecret), false);
    assert.equal(
      await runCli(
        ['provider', 'configure', 'groq', '--stdin', '--json'],
        agentContext,
      ),
      1,
    );
    assert.equal(JSON.parse(agentOutput.at(-1)!).error.code, 'FORBIDDEN');
    assert.equal(await secrets.get('groq'), undefined);

    assert.equal(
      await runCli(['provider', 'test', 'openai', '--json'], humanContext),
      0,
    );
    assert.deepEqual(validationAuthorization, [`Bearer ${nextSecret}`]);
    nextSecret = 'CLI-CANARY-rotated';
    assert.equal(
      await runCli(['provider', 'configure', 'openai', '--json'], humanContext),
      0,
    );
    assert.equal(await secrets.get('openai'), nextSecret);
    assert.equal(output.at(-1)!.includes(nextSecret), false);

    assert.equal(
      await runCli(['provider', 'remove', 'openai', '--json'], humanContext),
      0,
    );
    assert.equal(await secrets.get('openai'), undefined);
    assert.equal(JSON.parse(output.at(-1)!).activeProvider, 'deterministic');

    const beforeRejectedInput = inputCalls.length;
    assert.equal(
      await runCli(
        ['provider', 'configure', 'openai', '--key', 'not-allowed'],
        humanContext,
      ),
      2,
    );
    assert.equal(inputCalls.length, beforeRejectedInput);
    assert.match(output.at(-1)!, /not accepted as command arguments/);
  } finally {
    await service.close();
    metadata.close();
    store.close();
  }
});

test('CLI reads and writes through the same service revision as the browser client', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rant-studio-cli-'));
  const store = openProjectStore(join(directory, 'project.db'));
  const humanCredential = store.issueCredential({
    role: 'human',
    scopes: ['project:*'],
  });
  const agentCredential = store.issueCredential({
    role: 'agent',
    scopes: ['project:read', 'note:add'],
  });
  const service = await startLocalService({ port: 0, store });
  const browserClient = new RantClient({
    baseUrl: service.url,
    credential: humanCredential.token,
  });
  const project = await browserClient.createProject('CLI Shared State');
  const output: string[] = [];

  const getExit = await runCli(['project', 'get', project.id], {
    baseUrl: service.url,
    credential: agentCredential.token,
    write: (line) => output.push(line),
  });
  assert.equal(getExit, 0);
  assert.deepEqual(JSON.parse(output.at(-1)!), {
    id: project.id,
    name: 'CLI Shared State',
    revision: 1,
  });

  const noteExit = await runCli(
    ['project', 'note', project.id, '--revision', '1', '--text', 'Agent note'],
    {
      baseUrl: service.url,
      credential: agentCredential.token,
      write: (line) => output.push(line),
    },
  );
  assert.equal(noteExit, 0);
  assert.equal((await browserClient.getProject(project.id)).revision, 2);

  await service.close();
  store.close();
});

test('CLI intake view reads the browser-visible source and timestamp words', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rant-studio-cli-intake-'));
  const store = openProjectStore(join(directory, 'project.db'));
  const humanCredential = store.issueCredential({
    role: 'human',
    scopes: ['project:*'],
  });
  const agentCredential = store.issueCredential({
    role: 'agent',
    scopes: ['project:read'],
  });
  const service = await startLocalService({ port: 0, store });
  const browserClient = new RantClient({
    baseUrl: service.url,
    credential: humanCredential.token,
  });
  const created = await browserClient.createProject('CLI Intake');
  const wav = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.alloc(4),
    Buffer.from('WAVEfmt '),
    Buffer.alloc(32),
  ]);
  const withAudio = await browserClient.uploadNarration(created.id, {
    bytesBase64: wav.toString('base64'),
    expectedRevision: 1,
    mimeType: 'audio/wav',
    originalName: 'narration.wav',
  });
  await browserClient.importTranscript(created.id, {
    expectedRevision: withAudio.revision,
    raw: { words: [{ endMs: 500, startMs: 0, text: 'Shared' }] },
    words: [{ endMs: 500, startMs: 0, text: 'Shared' }],
  });
  const output: string[] = [];

  const exit = await runCli(['project', 'intake', created.id], {
    baseUrl: service.url,
    credential: agentCredential.token,
    write: (line) => output.push(line),
  });

  assert.equal(exit, 0);
  const intake = JSON.parse(output.at(-1)!);
  assert.equal(intake.sourceAudio.originalName, 'narration.wav');
  assert.deepEqual(
    intake.transcript.words.map(
      (word: { text: string; startMs: number; endMs: number }) => ({
        endMs: word.endMs,
        startMs: word.startMs,
        text: word.text,
      }),
    ),
    [{ endMs: 500, startMs: 0, text: 'Shared' }],
  );

  await service.close();
  store.close();
});

test('CLI agent reads semantic context and submits a revision-bound proposal file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rant-studio-cli-proposal-'));
  const store = openProjectStore(join(directory, 'project.db'));
  const humanCredential = store.issueCredential({
    role: 'human',
    scopes: ['project:*'],
  });
  const agentCredential = store.issueCredential({
    role: 'agent',
    scopes: [
      'project:read',
      'task:claim',
      'proposal:write',
      'asset:add',
      'asset:recommend',
    ],
  });
  const service = await startLocalService({ port: 0, store });
  const human = new RantClient({
    baseUrl: service.url,
    credential: humanCredential.token,
  });
  const created = await human.createProject('CLI Proposal');
  const wav = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.alloc(4),
    Buffer.from('WAVEfmt '),
    Buffer.alloc(32),
  ]);
  await human.uploadNarration(created.id, {
    bytesBase64: wav.toString('base64'),
    expectedRevision: 1,
    mimeType: 'audio/wav',
    originalName: 'narration.wav',
  });
  const intake = await human.importTranscript(created.id, {
    expectedRevision: 2,
    raw: { words: [{ endMs: 500, startMs: 0, text: 'Shared' }] },
    words: [{ endMs: 500, startMs: 0, text: 'Shared' }],
  });
  const task = await human.createProposalTask(created.id, {
    constraints: {
      planning: {
        briefs: [],
        direction: 'Keep the complete thought together.',
        maxDurationMs: null,
        maxWordsPerShot: null,
        minDurationMs: null,
        mode: 'discover',
        targetShotCount: 1,
      },
    },
    expectedRevision: intake.revision,
    instruction: 'Discover one semantic shot.',
    pacing: 'Standard',
  });
  const output: string[] = [];
  const context = {
    baseUrl: service.url,
    credential: agentCredential.token,
    write: (line: string) => output.push(line),
  };

  assert.equal(await runCli(['agent', 'attach', created.id], context), 0);
  const session = JSON.parse(output.at(-1)!);
  assert.equal(
    await runCli(
      ['task', 'claim', created.id, task.id, '--session', session.id],
      context,
    ),
    0,
  );
  assert.equal(
    await runCli(['proposal', 'context', created.id, task.id], context),
    0,
  );
  const planning = JSON.parse(output.at(-1)!);
  assert.equal(planning.task.planning.mode, 'discover');
  assert.equal(planning.transcript.words[0].text, 'Shared');
  const proposalFile = join(directory, 'proposal.json');
  await writeFile(
    proposalFile,
    JSON.stringify({
      shots: [
        {
          endWordOrdinal: 0,
          id: '4a3ad699-e203-4af7-b7fd-0a5d19e26181',
          rationale: 'Keep the complete premise together.',
          startWordOrdinal: 0,
          theme: 'Shared premise',
          visualBrief: 'A single shared object in close-up.',
        },
      ],
      summary: 'The transcript is one complete semantic thought.',
    }),
  );
  assert.equal(
    await runCli(
      [
        'proposal',
        'submit',
        created.id,
        task.id,
        '--revision',
        String(planning.baseProjectRevision),
        '--transcript',
        planning.baseTranscriptRevisionId,
        '--shots-file',
        proposalFile,
      ],
      context,
    ),
    0,
  );
  const ready = await human.getEditorial(created.id);
  assert.equal(ready.proposals[0]?.status, 'ready');
  await human.acceptShotProposal(created.id, ready.proposals[0]!.id, {
    expectedRevision: ready.revision,
  });
  assert.equal(await runCli(['project', 'ledger', created.id], context), 0);
  const ledger = JSON.parse(output.at(-1)!);
  assert.equal(ledger.revision, 4);
  assert.equal(ledger.shots[0].theme, 'Shared premise');
  assert.equal(ledger.shots[0].id, ready.proposals[0]?.shots[0]?.id);

  const assetTask = await human.createAssetTask(created.id, {
    expectedRevision: 4,
    instruction: 'Attach one local visual.',
    shotIds: [ledger.shots[0].id],
  });
  assert.equal(
    await runCli(
      ['task', 'claim', created.id, assetTask.id, '--session', session.id],
      context,
    ),
    0,
  );
  const pngPath = join(directory, 'visual.png');
  await writeFile(
    pngPath,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(32),
    ]),
  );
  const unsafeAssetArgs = [
    'asset',
    'attach',
    created.id,
    '--revision',
    '4',
    '--shots',
    ledger.shots[0].id,
    '--file',
  ];
  const linkedPngPath = join(directory, 'linked.png');
  await symlink(pngPath, linkedPngPath);
  assert.equal(await runCli([...unsafeAssetArgs, linkedPngPath], context), 2);
  assert.match(output.at(-1)!, /regular file, not a symbolic link/);
  const unsupportedPath = join(directory, 'visual.gif');
  await writeFile(unsupportedPath, await readFile(pngPath));
  assert.equal(await runCli([...unsafeAssetArgs, unsupportedPath], context), 2);
  assert.match(output.at(-1)!, /supports only \.png and \.mp4 files/);
  const directoryPath = join(directory, 'visual-dir.png');
  await mkdir(directoryPath);
  assert.equal(await runCli([...unsafeAssetArgs, directoryPath], context), 2);
  assert.match(output.at(-1)!, /regular file, not a symbolic link/);
  const beforeSafeAttach = await human.getAssets(created.id);
  assert.equal(beforeSafeAttach.revision, 4);
  assert.equal(beforeSafeAttach.assets.length, 0);
  await assert.rejects(
    readdir(join(directory, 'media', created.id, 'assets')),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'ENOENT',
  );
  assert.equal(
    await runCli(
      [
        'asset',
        'attach',
        created.id,
        '--revision',
        '4',
        '--shots',
        ledger.shots[0].id,
        '--file',
        pngPath,
        '--task',
        assetTask.id,
      ],
      context,
    ),
    0,
  );
  const cliAsset = JSON.parse(output.at(-1)!);
  assert.equal(
    await runCli(
      [
        'task',
        'transition',
        created.id,
        assetTask.id,
        '--revision',
        '5',
        '--status',
        'succeeded',
        '--idempotency',
        'cli-success',
        '--summary',
        'Attached visual.png.',
      ],
      context,
    ),
    0,
  );
  assert.equal(
    await runCli(
      [
        'asset',
        'recommend',
        created.id,
        '--revision',
        '5',
        '--shot',
        ledger.shots[0].id,
        '--asset',
        cliAsset.assets[0].id,
        '--reason',
        'Concrete visual match.',
      ],
      context,
    ),
    0,
  );
  assert.equal(await runCli(['project', 'activity', created.id], context), 0);
  const activity = JSON.parse(output.at(-1)!);
  assert.equal(activity.tasks[0].status, 'succeeded');
  assert.equal(activity.receipts[0].summary, 'Attached visual.png.');

  await service.close();
  store.close();
});
