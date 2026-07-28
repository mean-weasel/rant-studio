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
import { openProjectStore } from '../../apps/service/src/store.ts';
import { startLocalService } from '../../apps/service/src/server.ts';
import { RantClient } from '../../packages/api/src/index.ts';

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

test('CLI agent attaches, claims, and submits a revision-bound shot proposal', async () => {
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
    constraints: {},
    expectedRevision: intake.revision,
    instruction: 'One shot.',
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
    await runCli(
      ['proposal', 'submit-chronological', created.id, task.id, '--shots', '1'],
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
  assert.equal(ledger.shots[0].theme, 'Beat 1');

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
