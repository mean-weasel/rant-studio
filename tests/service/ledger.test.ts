import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openProjectStore } from '../../apps/service/src/store.ts';
import { startLocalService } from '../../apps/service/src/server.ts';
import { RantApiError, RantClient } from '../../packages/api/src/index.ts';

async function acceptedLedgerFixture() {
  const root = await mkdtemp(join(tmpdir(), 'rant-studio-ledger-'));
  const databasePath = join(root, 'project.db');
  const store = openProjectStore(databasePath);
  const humanCredential = store.issueCredential({
    role: 'human',
    scopes: ['project:*'],
  });
  const agentCredential = store.issueCredential({
    role: 'agent',
    scopes: ['project:read', 'task:claim', 'proposal:write'],
  });
  const service = await startLocalService({ port: 0, store });
  const human = new RantClient({
    baseUrl: service.url,
    credential: humanCredential.token,
  });
  const agent = new RantClient({
    baseUrl: service.url,
    credential: agentCredential.token,
  });
  const created = await human.createProject('Ledger');
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
  await human.importTranscript(created.id, {
    expectedRevision: 2,
    raw: {
      words: [
        { endMs: 250, startMs: 0, text: 'One' },
        { endMs: 500, startMs: 250, text: 'two' },
        { endMs: 750, startMs: 500, text: 'three' },
        { endMs: 1000, startMs: 750, text: 'four' },
      ],
    },
    words: [
      { endMs: 250, startMs: 0, text: 'One' },
      { endMs: 500, startMs: 250, text: 'two' },
      { endMs: 750, startMs: 500, text: 'three' },
      { endMs: 1000, startMs: 750, text: 'four' },
    ],
  });
  const editorial = await human.getEditorial(created.id);
  const task = await human.createProposalTask(created.id, {
    constraints: {},
    expectedRevision: 3,
    instruction: 'Two shots',
    pacing: 'Standard',
  });
  const session = await agent.attachAgent(created.id);
  await agent.claimProposalTask(created.id, task.id, session.id);
  const proposal = await agent.submitShotProposal(created.id, task.id, {
    baseProjectRevision: 3,
    baseTranscriptRevisionId: editorial.effectiveTranscript.id,
    shots: [
      {
        endWordOrdinal: 1,
        rationale: 'First beat.',
        startWordOrdinal: 0,
        theme: 'First',
      },
      {
        endWordOrdinal: 3,
        rationale: 'Second beat.',
        startWordOrdinal: 2,
        theme: 'Second',
      },
    ],
  });
  await human.acceptShotProposal(created.id, proposal.id, {
    expectedRevision: 3,
  });
  return {
    agent,
    databasePath,
    human,
    humanCredential,
    projectId: created.id,
    service,
    store,
  };
}

test('ledger reorder preserves logical IDs while split and merge create attributed ancestry', async () => {
  const fixture = await acceptedLedgerFixture();
  try {
    const initial = await fixture.human.getLedger(fixture.projectId);
    const initialIds = initial.shots.map((shot) => shot.id);

    await assert.rejects(
      fixture.agent.editLedger(fixture.projectId, {
        expectedRevision: initial.revision,
        operation: { kind: 'reorder', shotIds: [...initialIds].reverse() },
      }),
      (error: unknown) =>
        error instanceof RantApiError && error.code === 'FORBIDDEN',
    );
    assert.equal(
      (await fixture.human.getLedger(fixture.projectId)).revision,
      4,
    );

    const reordered = await fixture.human.editLedger(fixture.projectId, {
      expectedRevision: 4,
      operation: { kind: 'reorder', shotIds: [...initialIds].reverse() },
    });
    assert.deepEqual(
      reordered.shots.map((shot) => shot.id),
      [...initialIds].reverse(),
    );

    const split = await fixture.human.editLedger(fixture.projectId, {
      expectedRevision: 5,
      operation: {
        atWordOrdinal: 3,
        kind: 'split',
        shotId: reordered.shots[0]!.id,
      },
    });
    const splitChildren = split.shots.slice(0, 2);
    assert.equal(splitChildren.length, 2);
    assert.ok(splitChildren.every((shot) => !initialIds.includes(shot.id)));
    assert.ok(
      split.ancestry.filter(
        (edge) => edge.parentShotId === reordered.shots[0]!.id,
      ).length === 2,
    );

    const merged = await fixture.human.editLedger(fixture.projectId, {
      expectedRevision: 6,
      operation: {
        kind: 'merge',
        leftShotId: splitChildren[0]!.id,
        rightShotId: splitChildren[1]!.id,
      },
    });
    assert.equal(merged.shots.length, 2);
    assert.ok(!splitChildren.some((shot) => shot.id === merged.shots[0]!.id));
    assert.equal(
      merged.ancestry.filter((edge) => edge.childShotId === merged.shots[0]!.id)
        .length,
      2,
    );
    assert.deepEqual(
      merged.history.slice(0, 3).map((event) => event.operation),
      ['change_shots', 'change_shots', 'change_shots'],
    );
  } finally {
    await fixture.service.close();
    fixture.store.close();
  }
});

test('named checkpoint restore and undo survive restart without reusing stale revisions', async () => {
  const fixture = await acceptedLedgerFixture();
  const initial = await fixture.human.getLedger(fixture.projectId);
  const checkpoint = await fixture.human.createLedgerCheckpoint(
    fixture.projectId,
    {
      expectedRevision: initial.revision,
      name: 'Before cut',
    },
  );
  const cut = await fixture.human.editLedger(fixture.projectId, {
    expectedRevision: initial.revision,
    operation: { kind: 'cut', shotId: initial.shots[0]!.id },
  });
  assert.equal(cut.shots.length, 1);
  const restored = await fixture.human.restoreLedgerCheckpoint(
    fixture.projectId,
    checkpoint.id,
    { expectedRevision: cut.revision },
  );
  assert.deepEqual(
    restored.shots.map((shot) => shot.id),
    initial.shots.map((shot) => shot.id),
  );
  const undone = await fixture.human.undoLedger(fixture.projectId, {
    expectedRevision: restored.revision,
  });
  assert.equal(undone.shots.length, 1);

  await fixture.service.close();
  fixture.store.close();
  const reopened = openProjectStore(fixture.databasePath);
  assert.equal(reopened.getLedgerProject(fixture.projectId).shots.length, 1);
  reopened.close();
});
