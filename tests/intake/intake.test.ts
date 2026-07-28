import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RantApiError, RantClient } from '../../packages/api/src/index.ts';
import type {
  TranscriptProvider,
  TranscriptProviderResult,
} from '../../packages/transcription/src/index.ts';
import { openProjectStore } from '../../apps/service/src/store.ts';
import { startLocalService } from '../../apps/service/src/server.ts';

const wavBytes = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WAVEfmt '),
  Buffer.alloc(32),
]);

async function temporaryWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'rant-studio-intake-'));
  return {
    databasePath: join(root, 'project.db'),
    importRoot: join(root, 'imports'),
    managedRoot: join(root, 'managed'),
    root,
  };
}

class SequenceProvider implements TranscriptProvider {
  readonly name = 'deterministic-fixture';
  calls = 0;

  async transcribe(): Promise<TranscriptProviderResult> {
    this.calls += 1;
    if (this.calls === 2) throw new Error('fixture provider unavailable');
    return {
      raw: {
        model: 'fixture-v1',
        words: [
          { endMs: 420, startMs: 0, text: 'Every' },
          { endMs: 900, startMs: 420, text: 'subscription' },
        ],
      },
      words: [
        { endMs: 420, startMs: 0, text: 'Every' },
        { endMs: 900, startMs: 420, text: 'subscription' },
      ],
    };
  }
}

test('intake persists managed audio, raw provider evidence, words, retries, and restart state', async () => {
  const workspace = await temporaryWorkspace();
  const provider = new SequenceProvider();
  const store = openProjectStore(workspace.databasePath, {
    importRoot: workspace.importRoot,
    managedRoot: workspace.managedRoot,
  });
  const credential = store.issueCredential({ role: 'human', scopes: ['project:*'] });
  const service = await startLocalService({ port: 0, provider, store });
  const client = new RantClient({
    baseUrl: service.url,
    credential: credential.token,
  });

  const project = await client.createProject('Subscription Fatigue');
  const withAudio = await client.uploadNarration(project.id, {
    bytesBase64: wavBytes.toString('base64'),
    expectedRevision: project.revision,
    mimeType: 'audio/wav',
    originalName: 'narration.wav',
  });
  assert.equal(withAudio.revision, 2);
  assert.equal(withAudio.sourceAudio?.originalName, 'narration.wav');
  assert.match(withAudio.sourceAudio?.checksum ?? '', /^[a-f0-9]{64}$/);

  await assert.rejects(
    client.importTranscript(project.id, {
      expectedRevision: 2,
      raw: { words: [{ endMs: 50, startMs: 100, text: 'broken' }] },
      words: [{ endMs: 50, startMs: 100, text: 'broken' }],
    }),
    (error: unknown) =>
      error instanceof RantApiError && error.code === 'INVALID_TRANSCRIPT',
  );
  assert.equal((await client.getIntake(project.id)).revision, 2);

  const transcribed = await client.runTranscription(project.id, {
    expectedRevision: 2,
  });
  assert.equal(transcribed.revision, 3);
  assert.deepEqual(
    transcribed.transcript?.words.map(({ text, startMs, endMs }) => ({
      endMs,
      startMs,
      text,
    })),
    [
      { endMs: 420, startMs: 0, text: 'Every' },
      { endMs: 900, startMs: 420, text: 'subscription' },
    ],
  );
  assert.equal(transcribed.attempts[0]?.status, 'succeeded');
  const rawPath = transcribed.attempts[0]?.rawArtifactPath;
  assert.ok(rawPath);
  assert.match(await readFile(rawPath, 'utf8'), /fixture-v1/);

  await assert.rejects(
    client.runTranscription(project.id, { expectedRevision: 3 }),
    (error: unknown) =>
      error instanceof RantApiError && error.code === 'PROVIDER_FAILED',
  );
  const afterFailure = await client.getIntake(project.id);
  assert.equal(afterFailure.revision, 3);
  assert.equal(afterFailure.transcript?.words[0]?.text, 'Every');
  assert.deepEqual(
    afterFailure.attempts.map(({ status }) => status),
    ['failed', 'succeeded'],
  );

  await service.close();
  store.close();

  const reopened = openProjectStore(workspace.databasePath, {
    importRoot: workspace.importRoot,
    managedRoot: workspace.managedRoot,
  });
  assert.equal(reopened.getIntakeProject(project.id).transcript?.words.length, 2);
  reopened.close();
});

test('intake rejects traversal, unsupported bytes, and symlinked local imports non-destructively', async () => {
  const workspace = await temporaryWorkspace();
  const store = openProjectStore(workspace.databasePath, {
    importRoot: workspace.importRoot,
    managedRoot: workspace.managedRoot,
  });
  const credential = store.issueCredential({ role: 'human', scopes: ['project:*'] });
  const service = await startLocalService({
    port: 0,
    provider: new SequenceProvider(),
    store,
  });
  const client = new RantClient({
    baseUrl: service.url,
    credential: credential.token,
  });
  const project = await client.createProject('Safe imports');

  await assert.rejects(
    client.uploadNarration(project.id, {
      bytesBase64: Buffer.from('not audio').toString('base64'),
      expectedRevision: 1,
      mimeType: 'audio/wav',
      originalName: '../escape.wav',
    }),
    (error: unknown) =>
      error instanceof RantApiError && error.code === 'UNSAFE_PATH',
  );

  await writeFile(join(workspace.root, 'outside.wav'), wavBytes);
  await import('node:fs/promises').then(({ mkdir }) =>
    mkdir(workspace.importRoot, { recursive: true }),
  );
  await symlink(
    join(workspace.root, 'outside.wav'),
    join(workspace.importRoot, 'linked.wav'),
  );
  await assert.rejects(
    client.importNarrationPath(project.id, {
      expectedRevision: 1,
      path: join(workspace.importRoot, 'linked.wav'),
    }),
    (error: unknown) =>
      error instanceof RantApiError && error.code === 'UNSAFE_PATH',
  );
  assert.equal((await client.getIntake(project.id)).revision, 1);

  await service.close();
  store.close();
});
