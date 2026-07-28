import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openProjectStore } from '../../apps/service/src/store.ts';
import { startLocalService } from '../../apps/service/src/server.ts';
import { RantApiError, RantClient } from '../../packages/api/src/index.ts';

const wav = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WAVEfmt '),
  Buffer.alloc(32),
]);

async function editorialFixture() {
  const root = await mkdtemp(join(tmpdir(), 'rant-studio-editorial-'));
  const store = openProjectStore(join(root, 'project.db'));
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
  const created = await human.createProject('Editorial truth');
  const withAudio = await human.uploadNarration(created.id, {
    bytesBase64: wav.toString('base64'),
    expectedRevision: 1,
    mimeType: 'audio/wav',
    originalName: 'narration.wav',
  });
  const intake = await human.importTranscript(created.id, {
    expectedRevision: withAudio.revision,
    raw: {
      words: [
        { endMs: 300, startMs: 0, text: 'Every' },
        { endMs: 700, startMs: 300, text: 'app' },
        { endMs: 1000, startMs: 700, text: 'claims' },
        { endMs: 1400, startMs: 1000, text: 'exception' },
      ],
    },
    words: [
      { endMs: 300, startMs: 0, text: 'Every' },
      { endMs: 700, startMs: 300, text: 'app' },
      { endMs: 1000, startMs: 700, text: 'claims' },
      { endMs: 1400, startMs: 1000, text: 'exception' },
    ],
  });
  return { agent, human, intake, service, store };
}

test('corrections preserve raw words and accepted agent proposals create exact shots under human authority', async () => {
  const fixture = await editorialFixture();
  try {
    const before = await fixture.human.getEditorial(fixture.intake.id);
    const corrected = await fixture.human.correctTranscript(fixture.intake.id, {
      expectedRevision: before.revision,
      replacementText: 'application',
      wordId: before.effectiveTranscript.words[1]!.id,
    });
    assert.equal(corrected.revision, 4);
    assert.equal(corrected.rawTranscript.words[1]?.text, 'app');
    assert.equal(corrected.effectiveTranscript.words[1]?.text, 'application');
    assert.equal(corrected.effectiveTranscript.words[1]?.startMs, 300);

    const task = await fixture.human.createProposalTask(fixture.intake.id, {
      constraints: { maxWordsPerShot: 3 },
      expectedRevision: 4,
      instruction: 'Create two chronological shots.',
      pacing: 'Punchy',
    });
    const session = await fixture.agent.attachAgent(fixture.intake.id);
    await fixture.agent.claimProposalTask(
      fixture.intake.id,
      task.id,
      session.id,
    );
    const proposal = await fixture.agent.submitShotProposal(
      fixture.intake.id,
      task.id,
      {
        baseProjectRevision: 4,
        baseTranscriptRevisionId: corrected.effectiveTranscript.id,
        shots: [
          {
            endWordOrdinal: 1,
            rationale: 'Open with the premise.',
            startWordOrdinal: 0,
            theme: 'Premise',
          },
          {
            endWordOrdinal: 3,
            rationale: 'Land the claim.',
            startWordOrdinal: 2,
            theme: 'Claim',
          },
        ],
      },
    );
    assert.equal(proposal.status, 'ready');
    assert.equal(
      (await fixture.human.getProject(fixture.intake.id)).revision,
      4,
    );

    await assert.rejects(
      fixture.agent.acceptShotProposal(fixture.intake.id, proposal.id, {
        expectedRevision: 4,
      }),
      (error: unknown) =>
        error instanceof RantApiError && error.code === 'FORBIDDEN',
    );

    const accepted = await fixture.human.acceptShotProposal(
      fixture.intake.id,
      proposal.id,
      { expectedRevision: 4 },
    );
    assert.equal(accepted.revision, 5);
    assert.equal(accepted.proposals[0]?.pacing, 'Punchy');
    assert.deepEqual(
      accepted.shots.map((shot) => ({
        endWordOrdinal: shot.endWordOrdinal,
        startWordOrdinal: shot.startWordOrdinal,
        theme: shot.theme,
      })),
      [
        { endWordOrdinal: 1, startWordOrdinal: 0, theme: 'Premise' },
        { endWordOrdinal: 3, startWordOrdinal: 2, theme: 'Claim' },
      ],
    );
    assert.ok(accepted.shots.every((shot) => /^[0-9a-f-]{36}$/.test(shot.id)));
    assert.equal(accepted.checkpoints.at(-1)?.name, 'Accepted shot proposal');
    assert.equal(accepted.tasks[0]?.status, 'succeeded');
  } finally {
    await fixture.service.close();
    fixture.store.close();
  }
});

test('invalid and stale proposals fail without partially changing accepted shots', async () => {
  const fixture = await editorialFixture();
  try {
    const editorial = await fixture.human.getEditorial(fixture.intake.id);
    const task = await fixture.human.createProposalTask(fixture.intake.id, {
      constraints: {},
      expectedRevision: editorial.revision,
      instruction: 'Propose shots.',
      pacing: 'Standard',
    });
    const session = await fixture.agent.attachAgent(fixture.intake.id);
    await fixture.agent.claimProposalTask(
      fixture.intake.id,
      task.id,
      session.id,
    );

    await assert.rejects(
      fixture.agent.submitShotProposal(fixture.intake.id, task.id, {
        baseProjectRevision: editorial.revision,
        baseTranscriptRevisionId: editorial.effectiveTranscript.id,
        shots: [
          {
            endWordOrdinal: 0,
            rationale: 'First.',
            startWordOrdinal: 0,
            theme: 'First',
          },
          {
            endWordOrdinal: 3,
            rationale: 'Gap is invalid.',
            startWordOrdinal: 2,
            theme: 'Second',
          },
        ],
      }),
      (error: unknown) =>
        error instanceof RantApiError && error.code === 'INVALID_PROPOSAL',
    );
    assert.equal(
      (await fixture.human.getEditorial(fixture.intake.id)).proposals.length,
      0,
    );

    const proposal = await fixture.agent.submitShotProposal(
      fixture.intake.id,
      task.id,
      {
        baseProjectRevision: editorial.revision,
        baseTranscriptRevisionId: editorial.effectiveTranscript.id,
        shots: [
          {
            endWordOrdinal: 3,
            rationale: 'One complete shot.',
            startWordOrdinal: 0,
            theme: 'Whole thought',
          },
        ],
      },
    );
    const corrected = await fixture.human.correctTranscript(fixture.intake.id, {
      expectedRevision: editorial.revision,
      replacementText: 'applications',
      wordId: editorial.effectiveTranscript.words[1]!.id,
    });
    await assert.rejects(
      fixture.human.acceptShotProposal(fixture.intake.id, proposal.id, {
        expectedRevision: corrected.revision,
      }),
      (error: unknown) =>
        error instanceof RantApiError && error.code === 'STALE_PROPOSAL',
    );
    const after = await fixture.human.getEditorial(fixture.intake.id);
    assert.equal(after.shots.length, 0);
    assert.equal(after.proposals[0]?.status, 'stale');
  } finally {
    await fixture.service.close();
    fixture.store.close();
  }
});
