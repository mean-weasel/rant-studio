import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { RantApiError, RantClient } from '../../packages/api/src/index.ts';
import type {
  TranscriptProvider,
  TranscriptProviderInput,
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

function createMedia(path: string, kind: 'mp3' | 'mp4' | 'video-only'): void {
  const audioInput = [
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=520:duration=0.4:sample_rate=48000',
  ];
  const args =
    kind === 'mp3'
      ? [...audioInput, '-c:a', 'libmp3lame', path]
      : [
          '-f',
          'lavfi',
          '-i',
          'color=c=blue:s=64x64:d=0.4',
          ...(kind === 'mp4' ? audioInput : []),
          '-t',
          '0.4',
          '-c:v',
          'mpeg4',
          ...(kind === 'mp4' ? ['-c:a', 'aac'] : []),
          path,
        ];
  const result = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', ...args],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function temporaryWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'rant-studio-intake-'));
  return {
    databasePath: join(root, 'project.db'),
    importRoot: join(root, 'imports'),
    managedRoot: join(root, 'managed'),
    root,
  };
}

class CapturingProvider implements TranscriptProvider {
  readonly name = 'capture-fixture';
  readonly inputs: TranscriptProviderInput[] = [];

  async transcribe(
    input: TranscriptProviderInput,
  ): Promise<TranscriptProviderResult> {
    this.inputs.push(input);
    return {
      raw: { provider: this.name },
      words: [{ endMs: 400, startMs: 0, text: 'Captured' }],
    };
  }
}

class SequenceProvider implements TranscriptProvider {
  readonly name = 'deterministic-fixture';
  calls = 0;

  async transcribe(): Promise<TranscriptProviderResult> {
    this.calls += 1;
    if (this.calls === 2) throw new Error('fixture provider unavailable');
    if (this.calls === 3) {
      return {
        raw: { model: 'fixture-v1', words: [] },
        words: [{ endMs: 50, startMs: 100, text: 'broken' }],
      };
    }
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

test('intake preserves MP3 and MP4 sources while normalizing provider and render audio to WAV', async () => {
  const workspace = await temporaryWorkspace();
  await mkdir(workspace.importRoot, { recursive: true });
  const mp3Path = join(workspace.importRoot, 'voice.mp3');
  const mp4Path = join(workspace.root, 'camera.mp4');
  createMedia(mp3Path, 'mp3');
  createMedia(mp4Path, 'mp4');
  const provider = new CapturingProvider();
  const store = openProjectStore(workspace.databasePath, {
    importRoot: workspace.importRoot,
    managedRoot: workspace.managedRoot,
  });
  const credential = store.issueCredential({
    role: 'human',
    scopes: ['project:*'],
  });
  const service = await startLocalService({ port: 0, provider, store });
  const client = new RantClient({
    baseUrl: service.url,
    credential: credential.token,
  });

  const project = await client.createProject('Real media intake');
  const mp3Bytes = await readFile(mp3Path);
  const withMp3 = await client.uploadNarration(project.id, {
    bytesBase64: mp3Bytes.toString('base64'),
    expectedRevision: project.revision,
    mimeType: 'audio/mpeg',
    originalName: 'voice.mp3',
  });
  assert.equal(withMp3.sourceAudio?.mimeType, 'audio/mpeg');
  assert.equal(withMp3.sourceAudio?.normalizedMimeType, 'audio/wav');
  assert.deepEqual(await readFile(withMp3.sourceAudio!.originalPath), mp3Bytes);
  assert.equal(
    (await readFile(withMp3.sourceAudio!.managedPath))
      .subarray(0, 4)
      .toString(),
    'RIFF',
  );

  const transcribed = await client.runTranscription(project.id, {
    expectedRevision: withMp3.revision,
  });
  assert.equal(transcribed.transcript?.words[0]?.text, 'Captured');
  assert.deepEqual(provider.inputs, [
    {
      checksum: withMp3.sourceAudio?.checksum,
      managedPath: withMp3.sourceAudio?.originalPath,
      mimeType: 'audio/mpeg',
    },
  ]);

  const mp4Bytes = await readFile(mp4Path);
  const withMp4 = await client.uploadNarration(project.id, {
    bytesBase64: mp4Bytes.toString('base64'),
    expectedRevision: transcribed.revision,
    mimeType: 'video/mp4',
    originalName: 'camera.mp4',
  });
  assert.equal(withMp4.sourceAudio?.originalName, 'camera.mp4');
  assert.equal(withMp4.sourceAudio?.mimeType, 'video/mp4');
  assert.deepEqual(await readFile(withMp4.sourceAudio!.originalPath), mp4Bytes);
  assert.notEqual(
    withMp4.sourceAudio?.checksum,
    withMp4.sourceAudio?.normalizedChecksum,
  );

  const pathProject = await client.createProject('Path import');
  const imported = await client.importNarrationPath(pathProject.id, {
    expectedRevision: pathProject.revision,
    path: mp3Path,
  });
  assert.equal(imported.sourceAudio?.originalName, 'voice.mp3');
  assert.equal(imported.sourceAudio?.mimeType, 'audio/mpeg');
  assert.equal(imported.sourceAudio?.normalizedMimeType, 'audio/wav');

  await service.close();
  store.close();

  const reopened = openProjectStore(workspace.databasePath, {
    importRoot: workspace.importRoot,
    managedRoot: workspace.managedRoot,
  });
  assert.equal(
    reopened.getIntakeProject(project.id).sourceAudio?.originalName,
    'camera.mp4',
  );
  reopened.close();
});

test('intake persists managed audio, raw provider evidence, words, retries, and restart state', async () => {
  const workspace = await temporaryWorkspace();
  const provider = new SequenceProvider();
  const store = openProjectStore(workspace.databasePath, {
    importRoot: workspace.importRoot,
    managedRoot: workspace.managedRoot,
  });
  const credential = store.issueCredential({
    role: 'human',
    scopes: ['project:*'],
  });
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

  await assert.rejects(
    client.runTranscription(project.id, { expectedRevision: 3 }),
    (error: unknown) =>
      error instanceof RantApiError && error.code === 'INVALID_TRANSCRIPT',
  );
  const afterInvalidResult = await client.getIntake(project.id);
  assert.deepEqual(
    afterInvalidResult.attempts.map(({ status }) => status),
    ['failed', 'failed', 'succeeded'],
  );

  await service.close();
  store.close();

  const interruptedDatabase = new Database(workspace.databasePath);
  interruptedDatabase
    .prepare(
      `INSERT INTO transcription_attempts
       (id, project_id, provider, status, raw_artifact_path, created_at, error_message)
       VALUES ('interrupted-attempt', ?, 'fixture', 'running', NULL, ?, NULL)`,
    )
    .run(project.id, new Date().toISOString());
  interruptedDatabase.close();

  const reopened = openProjectStore(workspace.databasePath, {
    importRoot: workspace.importRoot,
    managedRoot: workspace.managedRoot,
  });
  assert.equal(
    reopened.getIntakeProject(project.id).transcript?.words.length,
    2,
  );
  const recoveredAttempt = reopened
    .getIntakeProject(project.id)
    .attempts.find(({ id }) => id === 'interrupted-attempt');
  assert.deepEqual(recoveredAttempt, {
    errorMessage: 'Service restarted before transcription completed',
    id: 'interrupted-attempt',
    provider: 'fixture',
    rawArtifactPath: null,
    status: 'failed',
  });
  reopened.close();
});

test('intake rejects traversal, unsupported bytes, and symlinked local imports non-destructively', async () => {
  const workspace = await temporaryWorkspace();
  const store = openProjectStore(workspace.databasePath, {
    importRoot: workspace.importRoot,
    managedRoot: workspace.managedRoot,
  });
  const credential = store.issueCredential({
    role: 'human',
    scopes: ['project:*'],
  });
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

  await assert.rejects(
    client.uploadNarration(project.id, {
      bytesBase64: Buffer.from('not an mp3').toString('base64'),
      expectedRevision: 1,
      mimeType: 'audio/mpeg',
      originalName: 'fake.mp3',
    }),
    (error: unknown) =>
      error instanceof RantApiError && error.code === 'UNSUPPORTED_MEDIA',
  );

  const videoOnlyPath = join(workspace.root, 'video-only.mp4');
  createMedia(videoOnlyPath, 'video-only');
  await assert.rejects(
    client.uploadNarration(project.id, {
      bytesBase64: (await readFile(videoOnlyPath)).toString('base64'),
      expectedRevision: 1,
      mimeType: 'video/mp4',
      originalName: 'video-only.mp4',
    }),
    (error: unknown) =>
      error instanceof RantApiError && error.code === 'UNSUPPORTED_MEDIA',
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
  assert.deepEqual(
    (await readdir(workspace.managedRoot, { recursive: true })).filter(
      (entry) => /\.(mp4|partial|wav)$/.test(entry),
    ),
    [],
  );

  await service.close();
  store.close();
});
