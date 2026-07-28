import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '../../apps/cli/src/index.ts';
import { startLocalService } from '../../apps/service/src/server.ts';
import { openProjectStore } from '../../apps/service/src/store.ts';
import { RantClient } from '../../packages/api/src/index.ts';

function ffmpeg(args: string[]) {
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('fresh full oracle shares browser CLI truth and publishes receipt-backed dual artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rant-studio-release-oracle-'));
  const databasePath = join(root, 'rant-studio.sqlite');
  const managedRoot = join(root, 'media');
  const narrationPath = join(root, 'narration.wav');
  const humanImagePath = join(root, 'human.png');
  const agentImagePath = join(root, 'agent.png');
  ffmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=520:duration=1:sample_rate=48000',
    '-c:a',
    'pcm_s16le',
    narrationPath,
  ]);
  for (const [path, color] of [
    [humanImagePath, 'orange'],
    [agentImagePath, 'teal'],
  ]) {
    ffmpeg([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=320x240`,
      '-frames:v',
      '1',
      path,
    ]);
  }

  const store = openProjectStore(databasePath, { managedRoot });
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
  const output: string[] = [];
  const cli = {
    baseUrl: service.url,
    credential: agentCredential.token,
    write: (line: string) => output.push(line),
  };

  const project = await human.createProject('Fresh release oracle');
  await human.uploadNarration(project.id, {
    bytesBase64: (await readFile(narrationPath)).toString('base64'),
    expectedRevision: 1,
    mimeType: 'audio/wav',
    originalName: 'narration.wav',
  });
  await human.runTranscription(project.id, { expectedRevision: 2 });
  const editorial = await human.getEditorial(project.id);
  const proposalTask = await human.createProposalTask(project.id, {
    constraints: { targetShotCount: 2 },
    expectedRevision: editorial.revision,
    instruction: 'Create two chronological shots.',
    pacing: 'Standard',
  });
  assert.equal(await runCli(['agent', 'attach', project.id], cli), 0);
  const session = JSON.parse(output.at(-1)!);
  assert.equal(
    await runCli(
      ['task', 'claim', project.id, proposalTask.id, '--session', session.id],
      cli,
    ),
    0,
  );
  assert.equal(
    await runCli(
      [
        'proposal',
        'submit',
        project.id,
        proposalTask.id,
        '--revision',
        String(editorial.revision),
        '--transcript',
        editorial.effectiveTranscript.id,
        '--shots-json',
        JSON.stringify([
          {
            endWordOrdinal: 0,
            rationale: 'Open.',
            startWordOrdinal: 0,
            theme: 'Open',
          },
          {
            endWordOrdinal: 1,
            rationale: 'Land.',
            startWordOrdinal: 1,
            theme: 'Land',
          },
        ]),
      ],
      cli,
    ),
    0,
  );
  const ready = await human.getEditorial(project.id);
  await human.acceptShotProposal(project.id, ready.proposals[0]!.id, {
    expectedRevision: ready.revision,
  });
  const ledger = await human.getLedger(project.id);

  const humanAsset = await human.uploadVisualCandidate(project.id, {
    bytesBase64: (await readFile(humanImagePath)).toString('base64'),
    expectedRevision: ledger.revision,
    mimeType: 'image/png',
    originalName: 'human.png',
    shotIds: [ledger.shots[0]!.id],
  });
  const humanSelected = await human.selectVisual(project.id, {
    assetId: humanAsset.assets[0]!.id,
    expectedRevision: humanAsset.revision,
    shotId: ledger.shots[0]!.id,
  });

  const assetTask = await human.createAssetTask(project.id, {
    expectedRevision: humanSelected.revision,
    instruction: 'Attach the second visual.',
    shotIds: [ledger.shots[1]!.id],
  });
  assert.equal(
    await runCli(
      ['task', 'claim', project.id, assetTask.id, '--session', session.id],
      cli,
    ),
    0,
  );
  assert.equal(
    await runCli(
      [
        'asset',
        'attach',
        project.id,
        '--revision',
        String(humanSelected.revision),
        '--shots',
        ledger.shots[1]!.id,
        '--file',
        agentImagePath,
        '--task',
        assetTask.id,
      ],
      cli,
    ),
    0,
  );
  const withAgentAsset = JSON.parse(output.at(-1)!);
  assert.equal(
    await runCli(
      [
        'task',
        'transition',
        project.id,
        assetTask.id,
        '--revision',
        String(withAgentAsset.revision),
        '--status',
        'succeeded',
        '--idempotency',
        'release-oracle-asset',
        '--summary',
        'Attached agent visual for the second shot.',
      ],
      cli,
    ),
    0,
  );
  const agentAsset = withAgentAsset.assets.find(
    (asset: { provenance: { actorKind: string } }) =>
      asset.provenance.actorKind === 'agent',
  );
  const selected = await human.selectVisual(project.id, {
    assetId: agentAsset.id,
    expectedRevision: withAgentAsset.revision,
    shotId: ledger.shots[1]!.id,
  });

  const queued = await human.createRenderJob(project.id, {
    allowPlaceholders: false,
    expectedRevision: selected.revision,
    formats: ['landscape', 'vertical'],
  });
  const rendered = await human.runRenderJob(project.id, queued.id);
  assert.equal(rendered.status, 'succeeded', rendered.errorMessage ?? '');
  assert.equal(rendered.artifacts.length, 2);
  const activity = await human.getActivity(project.id);
  assert.equal(
    activity.receipts.some(
      (receipt) => receipt.summary === 'Attached agent visual for the second shot.',
    ),
    true,
  );
  assert.ok((await human.getLedger(project.id)).history.length > 0);

  const artifactEvidence = await Promise.all(
    rendered.artifacts.map(async (artifact) => ({
      checksum: createHash('sha256')
        .update(await readFile(artifact.publishedPath))
        .digest('hex'),
      format: artifact.format,
      height: artifact.height,
      width: artifact.width,
    })),
  );
  assert.deepEqual(
    artifactEvidence.map(({ format, width, height }) => ({
      format,
      height,
      width,
    })),
    [
      { format: 'landscape', height: 1080, width: 1920 },
      { format: 'vertical', height: 1920, width: 1080 },
    ],
  );

  await service.close();
  store.close();
  const reopenedStore = openProjectStore(databasePath, { managedRoot });
  const reopenedService = await startLocalService({ port: 0, store: reopenedStore });
  const reopenedHuman = new RantClient({
    baseUrl: reopenedService.url,
    credential: humanCredential.token,
  });
  assert.equal(
    (await reopenedHuman.getMedia(project.id)).jobs.find(
      (job) => job.id === rendered.id,
    )?.artifacts.length,
    2,
  );
  const reopenedOutput: string[] = [];
  assert.equal(
    await runCli(['project', 'media', project.id], {
      baseUrl: reopenedService.url,
      credential: agentCredential.token,
      write: (line) => reopenedOutput.push(line),
    }),
    0,
  );
  assert.equal(JSON.parse(reopenedOutput.at(-1)!).revision, selected.revision);
  await reopenedService.close();
  reopenedStore.close();

  process.stdout.write(
    `# release-oracle ${JSON.stringify({
      artifacts: artifactEvidence,
      projectId: project.id,
      receipts: activity.receipts.length,
      revision: selected.revision,
    })}\n`,
  );
});
