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
  return { agent, databasePath, human, intake, service, store };
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
    const staged = await fixture.human.getEditorial(fixture.intake.id);
    const corrected = await fixture.human.correctTranscript(fixture.intake.id, {
      expectedRevision: editorial.revision,
      replacementText: 'applications',
      wordId: editorial.effectiveTranscript.words[1]!.id,
    });
    await assert.rejects(
      fixture.human.adjustShotProposal(fixture.intake.id, proposal.id, {
        shots: staged.proposals[0]!.shots,
      }),
      (error: unknown) =>
        error instanceof RantApiError && error.code === 'STALE_PROPOSAL',
    );
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

    const staleTask = await fixture.human.createProposalTask(
      fixture.intake.id,
      {
        constraints: {},
        expectedRevision: after.revision,
        instruction: 'This task will be invalidated by a note.',
        pacing: 'Standard',
      },
    );
    await fixture.agent.claimProposalTask(
      fixture.intake.id,
      staleTask.id,
      session.id,
    );
    await fixture.human.mutateProject(fixture.intake.id, {
      expectedRevision: after.revision,
      operation: 'add_note',
      payload: { note: 'Invalidate the revision without a transcript edit.' },
    });
    await assert.rejects(
      fixture.agent.submitShotProposal(fixture.intake.id, staleTask.id, {
        baseProjectRevision: after.revision,
        baseTranscriptRevisionId: corrected.effectiveTranscript.id,
        shots: [
          {
            endWordOrdinal: 3,
            rationale: 'One complete shot.',
            startWordOrdinal: 0,
            theme: 'Stale whole thought',
          },
        ],
      }),
      (error: unknown) =>
        error instanceof RantApiError && error.code === 'STALE_PROPOSAL',
    );
  } finally {
    await fixture.service.close();
    fixture.store.close();
  }
});

test('discover planning exposes shared context and requires a soft-target deviation explanation', async () => {
  const fixture = await editorialFixture();
  let closed = false;
  try {
    const editorial = await fixture.human.getEditorial(fixture.intake.id);
    const task = await fixture.human.createProposalTask(fixture.intake.id, {
      constraints: {
        planning: {
          briefs: [],
          direction: 'Keep each rhetorical claim intact.',
          maxDurationMs: null,
          maxWordsPerShot: 2,
          minDurationMs: null,
          mode: 'discover',
          targetShotCount: 3,
        },
      },
      expectedRevision: editorial.revision,
      instruction: 'Discover semantic structure.',
      pacing: 'Standard',
    });
    const activity = await fixture.agent.getActivity(fixture.intake.id);
    const sharedTask = activity.tasks.find(
      (candidate) => candidate.id === task.id,
    );
    assert.equal(sharedTask?.planning?.mode, 'discover');
    assert.equal(sharedTask?.planning?.maxWordsPerShot, 2);
    const session = await fixture.agent.attachAgent(fixture.intake.id);
    await fixture.agent.claimTask(fixture.intake.id, task.id, {
      sessionId: session.id,
    });
    const shots = [
      {
        endWordOrdinal: 1,
        id: '4746cff2-d3bf-44ac-b78f-b273638007a3',
        rationale: 'Keep the opening claim together.',
        startWordOrdinal: 0,
        theme: 'The claim',
      },
      {
        endWordOrdinal: 3,
        id: 'e776cc6f-96b2-4bda-bd4f-b96b82b8d0ee',
        rationale: 'Land the exception as the payoff.',
        startWordOrdinal: 2,
        theme: 'The exception',
      },
    ];
    await assert.rejects(
      fixture.agent.submitShotProposal(fixture.intake.id, task.id, {
        baseProjectRevision: editorial.revision,
        baseTranscriptRevisionId: editorial.effectiveTranscript.id,
        shots,
      }),
      (error: unknown) =>
        error instanceof RantApiError &&
        error.code === 'INVALID_PROPOSAL' &&
        /count-deviation explanation/.test(error.message),
    );
    await fixture.agent.submitShotProposal(fixture.intake.id, task.id, {
      baseProjectRevision: editorial.revision,
      baseTranscriptRevisionId: editorial.effectiveTranscript.id,
      shotCountRationale:
        'Two complete thoughts are clearer than forcing the soft target of three.',
      shots,
      summary: 'The transcript is a claim followed by its payoff.',
    });
    const staged = await fixture.human.getEditorial(fixture.intake.id);
    assert.equal(staged.shots.length, 0);
    assert.equal(
      staged.proposals[0]?.shotCountRationale,
      'Two complete thoughts are clearer than forcing the soft target of three.',
    );
    assert.deepEqual(
      staged.proposals[0]?.shots.map((shot) => shot.id),
      shots.map((shot) => shot.id),
    );
    const accepted = await fixture.human.acceptShotProposal(
      fixture.intake.id,
      staged.proposals[0]!.id,
      { expectedRevision: staged.revision },
    );
    assert.deepEqual(
      accepted.shots.map((shot) => shot.id),
      shots.map((shot) => shot.id),
    );
    assert.deepEqual(
      accepted.rawTranscript.words.map((word) => word.text),
      ['Every', 'app', 'claims', 'exception'],
    );
    const collisionTask = await fixture.human.createProposalTask(
      fixture.intake.id,
      {
        constraints: {},
        expectedRevision: accepted.revision,
        instruction: 'Do not reuse accepted shot identities.',
        pacing: 'Standard',
      },
    );
    await fixture.agent.claimTask(fixture.intake.id, collisionTask.id, {
      sessionId: session.id,
    });
    const collisionBase = {
      baseProjectRevision: accepted.revision,
      baseTranscriptRevisionId: accepted.effectiveTranscript.id,
    };
    await assert.rejects(
      fixture.agent.submitShotProposal(fixture.intake.id, collisionTask.id, {
        ...collisionBase,
        shots: [
          {
            endWordOrdinal: 3,
            id: 'not-a-uuid',
            rationale: 'Invalid staged identity.',
            startWordOrdinal: 0,
            theme: 'Invalid identity',
          },
        ],
      }),
      (error: unknown) =>
        error instanceof RantApiError &&
        error.code === 'INVALID_PROPOSAL' &&
        /must be UUIDs/.test(error.message),
    );
    await assert.rejects(
      fixture.agent.submitShotProposal(fixture.intake.id, collisionTask.id, {
        ...collisionBase,
        shots: [
          {
            endWordOrdinal: 3,
            id: accepted.shots[0]!.id,
            rationale: 'Colliding staged identity.',
            startWordOrdinal: 0,
            theme: 'Colliding identity',
          },
        ],
      }),
      (error: unknown) =>
        error instanceof RantApiError &&
        error.code === 'INVALID_PROPOSAL' &&
        /must not reuse/.test(error.message),
    );
    await fixture.service.close();
    fixture.store.close();
    closed = true;
    const reopened = openProjectStore(fixture.databasePath);
    try {
      const persisted = reopened.getEditorialProject(fixture.intake.id);
      assert.deepEqual(
        persisted.shots.map((shot) => shot.id),
        shots.map((shot) => shot.id),
      );
      assert.equal(
        persisted.tasks.find((candidate) => candidate.id === task.id)?.status,
        'succeeded',
      );
    } finally {
      reopened.close();
    }
  } finally {
    if (!closed) {
      await fixture.service.close();
      fixture.store.close();
    }
  }
});

test('outline planning deterministically maps one chronological shot to every ordered brief', async () => {
  const fixture = await editorialFixture();
  try {
    const editorial = await fixture.human.getEditorial(fixture.intake.id);
    const briefs = [
      {
        direction: 'State the broad claim.',
        id: 'brief-1',
        title: 'The claim',
      },
      {
        direction: 'Land the exception.',
        id: 'brief-2',
        title: 'The exception',
      },
    ];
    const task = await fixture.human.createProposalTask(fixture.intake.id, {
      constraints: {
        planning: {
          briefs,
          direction: 'Use the two supplied beats.',
          maxDurationMs: null,
          maxWordsPerShot: null,
          minDurationMs: null,
          mode: 'outline',
          targetShotCount: 2,
        },
      },
      expectedRevision: editorial.revision,
      instruction: 'Map the transcript to the ordered outline.',
      pacing: 'Punchy',
    });
    const session = await fixture.agent.attachAgent(fixture.intake.id);
    await fixture.agent.claimTask(fixture.intake.id, task.id, {
      sessionId: session.id,
    });
    const base = {
      baseProjectRevision: editorial.revision,
      baseTranscriptRevisionId: editorial.effectiveTranscript.id,
    };
    const shots = [
      {
        briefId: 'brief-1',
        endWordOrdinal: 1,
        rationale: 'The first two words establish the claim.',
        startWordOrdinal: 0,
        theme: 'The claim',
      },
      {
        briefId: 'brief-2',
        endWordOrdinal: 3,
        rationale: 'The last two words land the exception.',
        startWordOrdinal: 2,
        theme: 'The exception',
      },
    ];
    await assert.rejects(
      fixture.agent.submitShotProposal(fixture.intake.id, task.id, {
        ...base,
        shots: shots.map((shot) => ({
          ...shot,
          briefId: shot.briefId === 'brief-1' ? 'brief-2' : 'brief-1',
        })),
      }),
      (error: unknown) =>
        error instanceof RantApiError &&
        error.code === 'INVALID_PROPOSAL' &&
        /must map to outline brief/.test(error.message),
    );
    await fixture.agent.submitShotProposal(fixture.intake.id, task.id, {
      ...base,
      shots,
      summary: 'Mapped both creator briefs without changing their order.',
    });
    const staged = await fixture.human.getEditorial(fixture.intake.id);
    assert.equal(
      staged.proposals[0]?.summary,
      'Mapped both creator briefs without changing their order.',
    );
    assert.deepEqual(
      staged.proposals[0]?.shots.map((shot) => shot.briefId),
      ['brief-1', 'brief-2'],
    );
  } finally {
    await fixture.service.close();
    fixture.store.close();
  }
});
