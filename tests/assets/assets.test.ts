import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '../../apps/cli/src/index.ts';
import { openProjectStore } from '../../apps/service/src/store.ts';
import { startLocalService } from '../../apps/service/src/server.ts';
import { RantApiError, RantClient } from '../../packages/api/src/index.ts';

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32),
]);
const wav = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WAVEfmt '),
  Buffer.alloc(32),
]);

async function assetFixture() {
  const root = await mkdtemp(join(tmpdir(), 'rant-studio-assets-'));
  const databasePath = join(root, 'project.db');
  const managedRoot = join(root, 'managed');
  const store = openProjectStore(databasePath, {
    managedRoot,
  });
  const humanCredential = store.issueCredential({ role: 'human', scopes: ['project:*'] });
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
  const human = new RantClient({ baseUrl: service.url, credential: humanCredential.token });
  const agent = new RantClient({ baseUrl: service.url, credential: agentCredential.token });
  const project = await human.createProject('Assets');
  await human.uploadNarration(project.id, {
    bytesBase64: wav.toString('base64'),
    expectedRevision: 1,
    mimeType: 'audio/wav',
    originalName: 'narration.wav',
  });
  await human.importTranscript(project.id, {
    expectedRevision: 2,
    raw: {
      words: [
        { endMs: 500, startMs: 0, text: 'First' },
        { endMs: 1000, startMs: 500, text: 'Second' },
      ],
    },
    words: [
      { endMs: 500, startMs: 0, text: 'First' },
      { endMs: 1000, startMs: 500, text: 'Second' },
    ],
  });
  const editorial = await human.getEditorial(project.id);
  const task = await human.createProposalTask(project.id, {
    constraints: {},
    expectedRevision: 3,
    instruction: 'Two shots',
    pacing: 'Standard',
  });
  const session = await agent.attachAgent(project.id);
  await agent.claimProposalTask(project.id, task.id, session.id);
  const proposal = await agent.submitShotProposal(project.id, task.id, {
    baseProjectRevision: 3,
    baseTranscriptRevisionId: editorial.effectiveTranscript.id,
    shots: [
      {
        endWordOrdinal: 0,
        rationale: 'First.',
        startWordOrdinal: 0,
        theme: 'First',
      },
      {
        endWordOrdinal: 1,
        rationale: 'Second.',
        startWordOrdinal: 1,
        theme: 'Second',
      },
    ],
  });
  await human.acceptShotProposal(project.id, proposal.id, { expectedRevision: 3 });
  return {
    agent,
    agentToken: agentCredential.token,
    databasePath,
    human,
    humanToken: humanCredential.token,
    managedRoot,
    projectId: project.id,
    root,
    service,
    store,
  };
}

test('agent candidate attachment is multi-shot and provenance safe but human selection is protected', async () => {
  const fixture = await assetFixture();
  try {
    const ledger = await fixture.human.getLedger(fixture.projectId);
    const attached = await fixture.agent.uploadVisualCandidate(fixture.projectId, {
      bytesBase64: png.toString('base64'),
      expectedRevision: ledger.revision,
      mimeType: 'image/png',
      originalName: 'receipt.png',
      shotIds: ledger.shots.map((shot) => shot.id),
    });
    assert.equal(attached.revision, 5);
    assert.equal(attached.assets.length, 1);
    assert.equal(attached.assets[0]?.provenance.actorKind, 'agent');
    assert.deepEqual(
      attached.shots.map((shot) => shot.candidates.length),
      [1, 1],
    );
    assert.deepEqual(await readFile(attached.assets[0]!.managedPath), png);

    const selected = await fixture.human.selectVisual(fixture.projectId, {
      assetId: attached.assets[0]!.id,
      expectedRevision: 5,
      shotId: ledger.shots[0]!.id,
    });
    assert.equal(selected.shots[0]?.selectedAssetId, attached.assets[0]!.id);

    const duplicate = await fixture.agent.uploadVisualCandidate(fixture.projectId, {
      bytesBase64: png.toString('base64'),
      expectedRevision: selected.revision,
      mimeType: 'image/png',
      originalName: 'same-bytes.png',
      shotIds: ledger.shots.map((shot) => shot.id),
    });
    assert.equal(duplicate.assets.length, 1);
    assert.deepEqual(
      duplicate.shots.map((shot) => shot.candidates.length),
      [1, 1],
    );
    assert.equal(duplicate.shots[0]?.selectedAssetId, attached.assets[0]!.id);
    const recommended = await fixture.agent.recommendVisual(fixture.projectId, {
      assetId: attached.assets[0]!.id,
      expectedRevision: duplicate.revision,
      reason: 'The receipt metaphor supports the narration.',
      shotId: ledger.shots[1]!.id,
    });
    assert.equal(
      recommended.shots[1]?.recommendations[0]?.reason,
      'The receipt metaphor supports the narration.',
    );
    assert.equal(recommended.shots[0]?.selectedAssetId, attached.assets[0]!.id);

    await assert.rejects(
      fixture.agent.selectVisual(fixture.projectId, {
        assetId: attached.assets[0]!.id,
        expectedRevision: recommended.revision,
        shotId: ledger.shots[1]!.id,
      }),
      (error: unknown) =>
        error instanceof RantApiError && error.code === 'FORBIDDEN',
    );
    const after = await fixture.human.getAssets(fixture.projectId);
    assert.equal(after.revision, recommended.revision);
    assert.equal(after.shots[0]?.selectedAssetId, attached.assets[0]!.id);
    assert.equal(after.shots[1]?.selectedAssetId, null);
    const cleared = await fixture.human.clearVisual(fixture.projectId, {
      expectedRevision: after.revision,
      shotId: ledger.shots[0]!.id,
    });
    assert.equal(cleared.shots[0]?.selectedAssetId, null);
  } finally {
    await fixture.service.close();
    fixture.store.close();
  }
});

test('visual intake rejects unsafe names and unsupported bytes without candidates or revision changes', async () => {
  const fixture = await assetFixture();
  try {
    const ledger = await fixture.human.getLedger(fixture.projectId);
    await assert.rejects(
      fixture.human.uploadVisualCandidate(fixture.projectId, {
        bytesBase64: Buffer.from('not an image').toString('base64'),
        expectedRevision: ledger.revision,
        mimeType: 'image/png',
        originalName: '../escape.png',
        shotIds: [ledger.shots[0]!.id],
      }),
      (error: unknown) =>
        error instanceof RantApiError && error.code === 'UNSAFE_PATH',
    );
    const assets = await fixture.human.getAssets(fixture.projectId);
    assert.equal(assets.revision, ledger.revision);
    assert.equal(assets.assets.length, 0);

    const video = await fixture.human.uploadVisualCandidate(fixture.projectId, {
      bytesBase64: Buffer.concat([
        Buffer.from([0, 0, 0, 24]),
        Buffer.from('ftypisom'),
        Buffer.alloc(24),
      ]).toString('base64'),
      expectedRevision: ledger.revision,
      mimeType: 'video/mp4',
      originalName: 'clip.mp4',
      shotIds: [ledger.shots[0]!.id],
    });
    assert.equal(video.assets[0]?.kind, 'video');
    assert.equal(video.assets[0]?.mimeType, 'video/mp4');

    await assert.rejects(
      fixture.human.uploadVisualCandidate(fixture.projectId, {
        bytesBase64: Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.alloc(31),
          Buffer.from([7]),
        ]).toString('base64'),
        expectedRevision: ledger.revision,
        mimeType: 'image/png',
        originalName: 'stale.png',
        shotIds: [ledger.shots[0]!.id],
      }),
      (error: unknown) =>
        error instanceof RantApiError && error.code === 'REVISION_CONFLICT',
    );
    assert.equal(
      (
        await readdir(
          join(fixture.root, 'managed', fixture.projectId, 'assets'),
        )
      ).length,
      1,
    );
  } finally {
    await fixture.service.close();
    fixture.store.close();
  }
});

test('durable asset tasks cover claim, waiting, success, failure, cancellation, stale guards, and idempotent receipts', async () => {
  const fixture = await assetFixture();
  try {
    const ledger = await fixture.human.getLedger(fixture.projectId);
    const task = await fixture.human.createAssetTask(fixture.projectId, {
      expectedRevision: ledger.revision,
      instruction: 'Find one visual that works across both beats.',
      shotIds: ledger.shots.map((shot) => shot.id),
    });
    assert.equal(task.status, 'queued');

    const session = await fixture.agent.attachAgent(fixture.projectId);
    assert.equal(
      (
        await fixture.agent.claimTask(fixture.projectId, task.id, {
          sessionId: session.id,
        })
      ).status,
      'claimed',
    );
    assert.equal(
      (
        await fixture.agent.transitionTask(fixture.projectId, task.id, {
          expectedProjectRevision: ledger.revision,
          idempotencyKey: 'running-1',
          status: 'running',
        })
      ).status,
      'running',
    );
    assert.equal(
      (
        await fixture.agent.transitionTask(fixture.projectId, task.id, {
          expectedProjectRevision: ledger.revision,
          idempotencyKey: 'waiting-1',
          status: 'waiting',
          summary: 'Need a concrete object rather than an abstract texture.',
        })
      ).status,
      'waiting',
    );
    await fixture.agent.transitionTask(fixture.projectId, task.id, {
      expectedProjectRevision: ledger.revision,
      idempotencyKey: 'running-2',
      status: 'running',
    });
    const attached = await fixture.agent.uploadVisualCandidate(fixture.projectId, {
      bytesBase64: png.toString('base64'),
      expectedRevision: ledger.revision,
      mimeType: 'image/png',
      originalName: 'shared.png',
      shotIds: ledger.shots.map((shot) => shot.id),
      taskId: task.id,
    });
    const completed = await fixture.agent.transitionTask(fixture.projectId, task.id, {
      expectedProjectRevision: attached.revision,
      idempotencyKey: 'terminal-success',
      status: 'succeeded',
      summary: 'Attached one checksum-verified candidate to both shots.',
    });
    const repeated = await fixture.agent.transitionTask(fixture.projectId, task.id, {
      expectedProjectRevision: attached.revision,
      idempotencyKey: 'terminal-success',
      status: 'succeeded',
      summary: 'Attached one checksum-verified candidate to both shots.',
    });
    assert.equal(repeated.receipt?.id, completed.receipt?.id);

    const failedTask = await fixture.human.createAssetTask(fixture.projectId, {
      expectedRevision: attached.revision,
      instruction: 'Try an unavailable source.',
      shotIds: [ledger.shots[0]!.id],
    });
    await fixture.agent.claimTask(fixture.projectId, failedTask.id, {
      sessionId: session.id,
    });
    await fixture.agent.transitionTask(fixture.projectId, failedTask.id, {
      expectedProjectRevision: attached.revision,
      idempotencyKey: 'terminal-failed',
      status: 'failed',
      summary: 'Source file was unavailable.',
    });
    const retriedTask = await fixture.human.retryTask(
      fixture.projectId,
      failedTask.id,
      { expectedProjectRevision: attached.revision },
    );
    assert.equal(retriedTask.retryOfTaskId, failedTask.id);
    await fixture.agent.claimTask(fixture.projectId, retriedTask.id, {
      sessionId: session.id,
    });
    assert.equal(
      (
        await fixture.agent.heartbeatTask(fixture.projectId, retriedTask.id, {
          leaseMs: 60_000,
        })
      ).status,
      'claimed',
    );

    const canceledTask = await fixture.human.createAssetTask(fixture.projectId, {
      expectedRevision: attached.revision,
      instruction: 'This request is no longer needed.',
      shotIds: [ledger.shots[1]!.id],
    });
    await fixture.human.transitionTask(fixture.projectId, canceledTask.id, {
      expectedProjectRevision: attached.revision,
      idempotencyKey: 'terminal-canceled',
      status: 'canceled',
      summary: 'Canceled by the creator.',
    });

    const staleTask = await fixture.human.createAssetTask(fixture.projectId, {
      expectedRevision: attached.revision,
      instruction: 'Do not complete against a changed selection.',
      shotIds: [ledger.shots[0]!.id],
    });
    await fixture.agent.claimTask(fixture.projectId, staleTask.id, {
      sessionId: session.id,
    });
    const selected = await fixture.human.selectVisual(fixture.projectId, {
      assetId: attached.assets[0]!.id,
      expectedRevision: attached.revision,
      shotId: ledger.shots[0]!.id,
    });
    await assert.rejects(
      fixture.agent.transitionTask(fixture.projectId, staleTask.id, {
        expectedProjectRevision: selected.revision,
        idempotencyKey: 'stale-success',
        status: 'succeeded',
        summary: 'This result was based on the prior revision.',
      }),
      (error: unknown) =>
        error instanceof RantApiError && error.code === 'STALE_TASK',
    );

    const activity = await fixture.human.getActivity(fixture.projectId);
    assert.equal(
      activity.receipts.filter((receipt) => receipt.taskId === task.id).length,
      1,
    );
    assert.deepEqual(
      new Set(activity.tasks.map(({ status }) => status)),
      new Set(['succeeded', 'failed', 'canceled', 'claimed']),
    );
    assert.deepEqual(activity.tasks[0]?.shotIds.length ? true : false, true);
    assert.equal(
      (await fixture.human.getActivity(fixture.projectId, { status: 'failed' }))
        .tasks.length,
      1,
    );

    const expiringTask = await fixture.human.createAssetTask(fixture.projectId, {
      expectedRevision: selected.revision,
      instruction: 'This claim should become reclaimable.',
      shotIds: [ledger.shots[1]!.id],
    });
    await fixture.agent.claimTask(fixture.projectId, expiringTask.id, {
      leaseMs: 0,
      sessionId: session.id,
    });
    const afterExpiry = await fixture.human.getActivity(fixture.projectId);
    assert.equal(
      afterExpiry.tasks.find((candidate) => candidate.id === expiringTask.id)?.status,
      'queued',
    );
    assert.equal(
      afterExpiry.receipts.some(
        (receipt) =>
          receipt.taskId === expiringTask.id && receipt.result === 'interrupted',
      ),
      true,
    );
    assert.equal(
      (
        await fixture.agent.claimTask(fixture.projectId, expiringTask.id, {
          sessionId: session.id,
        })
      ).status,
      'claimed',
    );
  } finally {
    await fixture.service.close();
    fixture.store.close();
  }
});

test('asset state, task receipts, and one revision truth survive a real store and service restart', async () => {
  const fixture = await assetFixture();
  const ledger = await fixture.human.getLedger(fixture.projectId);
  const attached = await fixture.agent.uploadVisualCandidate(fixture.projectId, {
    bytesBase64: png.toString('base64'),
    expectedRevision: ledger.revision,
    mimeType: 'image/png',
    originalName: 'restart.png',
    shotIds: ledger.shots.map((shot) => shot.id),
  });
  const selected = await fixture.human.selectVisual(fixture.projectId, {
    assetId: attached.assets[0]!.id,
    expectedRevision: attached.revision,
    shotId: ledger.shots[0]!.id,
  });
  const recommended = await fixture.agent.recommendVisual(fixture.projectId, {
    assetId: attached.assets[0]!.id,
    expectedRevision: selected.revision,
    reason: 'Persist this recommendation across restart.',
    shotId: ledger.shots[1]!.id,
  });

  const session = await fixture.agent.attachAgent(fixture.projectId);
  const succeededTask = await fixture.human.createAssetTask(fixture.projectId, {
    expectedRevision: recommended.revision,
    instruction: 'Record a durable terminal receipt.',
    shotIds: [ledger.shots[0]!.id],
  });
  await fixture.agent.claimTask(fixture.projectId, succeededTask.id, {
    sessionId: session.id,
  });
  await fixture.agent.transitionTask(fixture.projectId, succeededTask.id, {
    expectedProjectRevision: recommended.revision,
    idempotencyKey: 'restart-running',
    status: 'running',
  });
  await fixture.agent.transitionTask(fixture.projectId, succeededTask.id, {
    expectedProjectRevision: recommended.revision,
    idempotencyKey: 'restart-succeeded',
    status: 'succeeded',
    summary: 'This receipt must survive restart exactly once.',
  });

  const failedTask = await fixture.human.createAssetTask(fixture.projectId, {
    expectedRevision: recommended.revision,
    instruction: 'Create retry lineage.',
    shotIds: [ledger.shots[1]!.id],
  });
  await fixture.agent.claimTask(fixture.projectId, failedTask.id, {
    sessionId: session.id,
  });
  await fixture.agent.transitionTask(fixture.projectId, failedTask.id, {
    expectedProjectRevision: recommended.revision,
    idempotencyKey: 'restart-failed',
    status: 'failed',
    summary: 'Retry after restart.',
  });
  const retry = await fixture.human.retryTask(fixture.projectId, failedTask.id, {
    expectedProjectRevision: recommended.revision,
  });

  const interruptedTask = await fixture.human.createAssetTask(fixture.projectId, {
    expectedRevision: recommended.revision,
    instruction: 'Reclaim this expired running task after restart.',
    shotIds: [ledger.shots[1]!.id],
  });
  await fixture.agent.claimTask(fixture.projectId, interruptedTask.id, {
    leaseMs: 0,
    sessionId: session.id,
  });
  await fixture.agent.transitionTask(fixture.projectId, interruptedTask.id, {
    expectedProjectRevision: recommended.revision,
    idempotencyKey: 'restart-interrupted-running',
    status: 'running',
  });

  await fixture.service.close();
  fixture.store.close();

  const reopenedStore = openProjectStore(fixture.databasePath, {
    managedRoot: fixture.managedRoot,
  });
  const reopenedService = await startLocalService({ port: 0, store: reopenedStore });
  const browserClient = new RantClient({
    baseUrl: reopenedService.url,
    credential: fixture.humanToken,
  });
  const agentClient = new RantClient({
    baseUrl: reopenedService.url,
    credential: fixture.agentToken,
  });
  try {
    const afterRestart = await browserClient.getAssets(fixture.projectId);
    assert.equal(afterRestart.revision, recommended.revision);
    assert.equal(afterRestart.assets[0]?.checksum, attached.assets[0]?.checksum);
    assert.equal(afterRestart.assets[0]?.provenance.actorKind, 'agent');
    assert.deepEqual(
      afterRestart.shots.map((shot) => shot.candidates),
      recommended.shots.map((shot) => shot.candidates),
    );
    assert.equal(
      afterRestart.shots[0]?.selectedAssetId,
      attached.assets[0]?.id,
    );
    assert.equal(
      afterRestart.shots[1]?.recommendations[0]?.reason,
      'Persist this recommendation across restart.',
    );
    assert.deepEqual(await readFile(afterRestart.assets[0]!.managedPath), png);

    const activity = await browserClient.getActivity(fixture.projectId);
    assert.equal(
      activity.receipts.filter((receipt) => receipt.taskId === succeededTask.id)
        .length,
      1,
    );
    assert.equal(
      activity.receipts.filter(
        (receipt) =>
          receipt.taskId === interruptedTask.id &&
          receipt.result === 'interrupted',
      ).length,
      1,
    );
    assert.equal(
      activity.tasks.find((task) => task.id === retry.id)?.retryOfTaskId,
      failedTask.id,
    );
    assert.equal(
      activity.tasks.find((task) => task.id === interruptedTask.id)?.status,
      'queued',
    );

    const restartedSession = await agentClient.attachAgent(fixture.projectId);
    assert.equal(
      (
        await agentClient.claimTask(fixture.projectId, interruptedTask.id, {
          sessionId: restartedSession.id,
        })
      ).status,
      'claimed',
    );

    const output: string[] = [];
    assert.equal(
      await runCli(['project', 'get', fixture.projectId], {
        baseUrl: reopenedService.url,
        credential: fixture.humanToken,
        write: (line) => output.push(line),
      }),
      0,
    );
    assert.equal(JSON.parse(output.at(-1)!).revision, afterRestart.revision);
    assert.equal(
      await runCli(['project', 'activity', fixture.projectId], {
        baseUrl: reopenedService.url,
        credential: fixture.humanToken,
        write: (line) => output.push(line),
      }),
      0,
    );
    assert.deepEqual(
      JSON.parse(output.at(-1)!).receipts,
      (await browserClient.getActivity(fixture.projectId)).receipts,
    );
  } finally {
    await reopenedService.close();
    reopenedStore.close();
  }
});
