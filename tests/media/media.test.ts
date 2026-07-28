import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openProjectStore } from '../../apps/service/src/store.ts';
import { startLocalService } from '../../apps/service/src/server.ts';
import { RantApiError, RantClient } from '../../packages/api/src/index.ts';

function command(program: string, args: string[]): string {
  const result = spawnSync(program, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function pixel(path: string, seconds: number, x: number, y: number): number[] {
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(seconds),
      '-i',
      path,
      '-vf',
      `crop=2:2:${x}:${y},scale=1:1`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ],
    { encoding: null },
  );
  assert.equal(result.status, 0, result.stderr.toString());
  return [...result.stdout.subarray(0, 3)];
}

function meanVolume(path: string, seconds: number, frequency: number): number {
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-ss',
      String(seconds),
      '-t',
      '0.55',
      '-i',
      path,
      '-af',
      `bandpass=f=${frequency}:width_type=h:width=120,volumedetect`,
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const match = result.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
  assert.ok(match, result.stderr);
  return Number(match[1]);
}

async function mediaFixture() {
  const root = await mkdtemp(join(tmpdir(), 'rant-studio-media-'));
  const databasePath = join(root, 'project.db');
  const managedRoot = join(root, 'managed');
  const narrationPath = join(root, 'narration.wav');
  const imagePath = join(root, 'still.png');
  const clipPath = join(root, 'clip.mp4');
  command('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1:sample_rate=48000',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:duration=1:sample_rate=48000',
    '-filter_complex',
    '[0:a][1:a]concat=n=2:v=0:a=1[a]',
    '-map',
    '[a]',
    '-c:a',
    'pcm_s16le',
    narrationPath,
  ]);
  command('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=320x240',
    '-frames:v',
    '1',
    imagePath,
  ]);
  command('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=320x240:r=30:d=0.4',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1500:duration=0.4:sample_rate=48000',
    '-t',
    '0.4',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    clipPath,
  ]);

  const store = openProjectStore(databasePath, { managedRoot });
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
  const project = await human.createProject('Media semantics');
  await human.uploadNarration(project.id, {
    bytesBase64: (await readFile(narrationPath)).toString('base64'),
    expectedRevision: 1,
    mimeType: 'audio/wav',
    originalName: 'narration.wav',
  });
  await human.importTranscript(project.id, {
    expectedRevision: 2,
    raw: {
      words: [
        { endMs: 1000, startMs: 0, text: 'first tone' },
        { endMs: 2000, startMs: 1000, text: 'second tone' },
      ],
    },
    words: [
      { endMs: 1000, startMs: 0, text: 'first tone' },
      { endMs: 2000, startMs: 1000, text: 'second tone' },
    ],
  });
  const editorial = await human.getEditorial(project.id);
  const task = await human.createProposalTask(project.id, {
    constraints: {},
    expectedRevision: 3,
    instruction: 'Two shots.',
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
        rationale: 'First tone.',
        startWordOrdinal: 0,
        theme: 'First',
      },
      {
        endWordOrdinal: 1,
        rationale: 'Second tone.',
        startWordOrdinal: 1,
        theme: 'Second',
      },
    ],
  });
  await human.acceptShotProposal(project.id, proposal.id, {
    expectedRevision: 3,
  });
  const ledger = await human.getLedger(project.id);
  const image = await human.uploadVisualCandidate(project.id, {
    bytesBase64: (await readFile(imagePath)).toString('base64'),
    expectedRevision: ledger.revision,
    mimeType: 'image/png',
    originalName: 'still.png',
    shotIds: [ledger.shots[0]!.id],
  });
  const selectedImage = await human.selectVisual(project.id, {
    assetId: image.assets[0]!.id,
    expectedRevision: image.revision,
    shotId: ledger.shots[0]!.id,
  });
  const video = await human.uploadVisualCandidate(project.id, {
    bytesBase64: (await readFile(clipPath)).toString('base64'),
    expectedRevision: selectedImage.revision,
    mimeType: 'video/mp4',
    originalName: 'clip.mp4',
    shotIds: [ledger.shots[1]!.id],
  });
  const selectedVideo = await human.selectVisual(project.id, {
    assetId: video.assets.find((asset) => asset.kind === 'video')!.id,
    expectedRevision: video.revision,
    shotId: ledger.shots[1]!.id,
  });
  return {
    agent,
    agentCredential,
    databasePath,
    human,
    humanCredential,
    managedRoot,
    projectId: project.id,
    revision: selectedVideo.revision,
    root,
    service,
    store,
  };
}

function probe(path: string) {
  return JSON.parse(
    command('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type,width,height,duration',
      '-of',
      'json',
      path,
    ]),
  ) as {
    format: { duration: string };
    streams: Array<{
      codec_type: string;
      duration?: string;
      height?: number;
      width?: number;
    }>;
  };
}

test('media preflight enforces human placeholder and stale revision authority', async () => {
  const fixture = await mediaFixture();
  try {
    const media = await fixture.human.getMedia(fixture.projectId);
    assert.equal(media.preflight.blockers.length, 0);
    assert.equal(media.preflight.incompleteShotIds.length, 0);
    await assert.rejects(
      fixture.agent.createRenderJob(fixture.projectId, {
        allowPlaceholders: false,
        expectedRevision: media.revision,
        formats: ['landscape'],
      }),
      (error: unknown) =>
        error instanceof RantApiError && error.code === 'FORBIDDEN',
    );
    const changed = await fixture.human.setFormatOverride(
      fixture.projectId,
      media.shots[0]!.id,
      {
        captionsEnabled: false,
        expectedRevision: media.revision,
        fit: 'contain',
        format: 'landscape',
      },
    );
    assert.equal(changed.shots[0]?.overrides.landscape.fit, 'contain');
    assert.equal(changed.shots[0]?.overrides.vertical.fit, 'contain');
    await assert.rejects(
      fixture.human.createRenderJob(fixture.projectId, {
        allowPlaceholders: false,
        expectedRevision: media.revision,
        formats: ['landscape'],
      }),
      (error: unknown) =>
        error instanceof RantApiError && error.code === 'REVISION_CONFLICT',
    );
    const assets = await fixture.human.getAssets(fixture.projectId);
    const cleared = await fixture.human.clearVisual(fixture.projectId, {
      expectedRevision: changed.revision,
      shotId: changed.shots[1]!.id,
    });
    const incomplete = await fixture.human.getMedia(fixture.projectId);
    assert.deepEqual(incomplete.preflight.incompleteShotIds, [
      changed.shots[1]!.id,
    ]);
    await assert.rejects(
      fixture.human.createRenderJob(fixture.projectId, {
        allowPlaceholders: false,
        expectedRevision: cleared.revision,
        formats: ['landscape'],
      }),
      (error: unknown) =>
        error instanceof RantApiError &&
        error.code === 'PLACEHOLDER_APPROVAL_REQUIRED',
    );
    const placeholderJob = await fixture.human.createRenderJob(
      fixture.projectId,
      {
        allowPlaceholders: true,
        expectedRevision: cleared.revision,
        formats: ['landscape'],
      },
    );
    assert.equal(placeholderJob.status, 'queued');
    const placeholderArtifact = await fixture.human.runRenderJob(
      fixture.projectId,
      placeholderJob.id,
    );
    assert.equal(placeholderArtifact.status, 'succeeded');
    const placeholderPixel = pixel(
      placeholderArtifact.artifacts[0]!.publishedPath,
      1.5,
      960,
      540,
    );
    assert.ok(
      placeholderPixel[0]! > placeholderPixel[1]! &&
        placeholderPixel[2]! > placeholderPixel[1]!,
    );
    assert.equal(assets.assets.length, 2);
  } finally {
    await fixture.service.close();
    fixture.store.close();
  }
});

test('shot and assembly previews render immutable final-timeline semantics', async () => {
  const fixture = await mediaFixture();
  try {
    const media = await fixture.human.getMedia(fixture.projectId);
    const shotPreview = await fixture.human.createPreview(fixture.projectId, {
      expectedRevision: media.revision,
      format: 'landscape',
      shotId: media.shots[1]!.id,
    });
    assert.equal(shotPreview.baseRevision, media.revision);
    assert.equal(shotPreview.shotId, media.shots[1]!.id);
    assert.equal(shotPreview.durationMs, 1000);
    const shotBytes = Buffer.from(
      await (
        await fixture.human.getPreviewArtifact(
          fixture.projectId,
          shotPreview.id,
        )
      ).arrayBuffer(),
    );
    assert.ok(shotBytes.length > 1_000);

    const assembly = await fixture.human.createPreview(fixture.projectId, {
      expectedRevision: media.revision,
      format: 'vertical',
    });
    assert.equal(assembly.shotId, null);
    assert.equal(assembly.durationMs, 2000);
    const assemblyBytes = Buffer.from(
      await (
        await fixture.human.getPreviewArtifact(fixture.projectId, assembly.id)
      ).arrayBuffer(),
    );
    assert.ok(assemblyBytes.length > 1_000);

    await fixture.human.setFormatOverride(
      fixture.projectId,
      media.shots[0]!.id,
      {
        captionsEnabled: false,
        expectedRevision: media.revision,
        fit: 'contain',
        format: 'landscape',
      },
    );
    await assert.rejects(
      fixture.human.createPreview(fixture.projectId, {
        expectedRevision: media.revision,
        format: 'landscape',
      }),
      (error: unknown) =>
        error instanceof RantApiError && error.code === 'REVISION_CONFLICT',
    );
  } finally {
    await fixture.service.close();
    fixture.store.close();
  }
});

test('artifacts render atomically in both formats and persist jobs across restart', async () => {
  const fixture = await mediaFixture();
  let currentRevision = fixture.revision;
  const ledger = await fixture.human.getLedger(fixture.projectId);
  const reordered = await fixture.human.editLedger(fixture.projectId, {
    expectedRevision: currentRevision,
    operation: {
      kind: 'reorder',
      shotIds: [...ledger.shots.map((shot) => shot.id)].reverse(),
    },
  });
  currentRevision = reordered.revision;
  const landscape = await fixture.human.setFormatOverride(
    fixture.projectId,
    reordered.shots[0]!.id,
    {
      captionsEnabled: false,
      expectedRevision: currentRevision,
      fit: 'cover',
      format: 'landscape',
    },
  );
  currentRevision = landscape.revision;
  const vertical = await fixture.human.setFormatOverride(
    fixture.projectId,
    reordered.shots[0]!.id,
    {
      captionsEnabled: true,
      expectedRevision: currentRevision,
      fit: 'contain',
      format: 'vertical',
    },
  );
  currentRevision = vertical.revision;

  const queued = await fixture.human.createRenderJob(fixture.projectId, {
    allowPlaceholders: false,
    expectedRevision: currentRevision,
    formats: ['landscape', 'vertical'],
  });
  const completed = await fixture.human.runRenderJob(
    fixture.projectId,
    queued.id,
  );
  assert.equal(completed.status, 'succeeded', completed.errorMessage ?? '');
  assert.equal(completed.artifacts.length, 2);
  for (const artifact of completed.artifacts) {
    const metadata = probe(artifact.publishedPath);
    const video = metadata.streams.find(
      (stream) => stream.codec_type === 'video',
    );
    const audio = metadata.streams.find(
      (stream) => stream.codec_type === 'audio',
    );
    assert.ok(video);
    assert.ok(audio);
    assert.ok(Math.abs(Number(metadata.format.duration) - 2) < 0.15);
    assert.equal(video.width, artifact.width);
    assert.equal(video.height, artifact.height);
    assert.equal(
      createHash('sha256')
        .update(await readFile(artifact.publishedPath))
        .digest('hex'),
      artifact.checksum,
    );
  }
  const landscapeArtifact = completed.artifacts.find(
    (artifact) => artifact.format === 'landscape',
  )!;
  const verticalArtifact = completed.artifacts.find(
    (artifact) => artifact.format === 'vertical',
  )!;
  assert.deepEqual(
    [landscapeArtifact.width, landscapeArtifact.height],
    [1920, 1080],
  );
  assert.deepEqual(
    [verticalArtifact.width, verticalArtifact.height],
    [1080, 1920],
  );
  const frozenBlue = pixel(landscapeArtifact.publishedPath, 0.8, 960, 540);
  assert.ok(frozenBlue[2]! > 180 && frozenBlue[0]! < 80);
  const stillRed = pixel(landscapeArtifact.publishedPath, 1.5, 960, 540);
  assert.ok(stillRed[0]! > 180 && stillRed[2]! < 80);
  const landscapeBottom = pixel(landscapeArtifact.publishedPath, 0.5, 20, 1000);
  const verticalCaptionBand = pixel(
    verticalArtifact.publishedPath,
    0.5,
    20,
    1800,
  );
  assert.ok(landscapeBottom[2]! > 150);
  assert.ok(verticalCaptionBand.every((channel) => channel < 40));
  const verticalContainBar = pixel(
    verticalArtifact.publishedPath,
    1.5,
    540,
    100,
  );
  assert.ok(verticalContainBar.every((channel) => channel < 40));

  const first880 = meanVolume(landscapeArtifact.publishedPath, 0.1, 880);
  const first440 = meanVolume(landscapeArtifact.publishedPath, 0.1, 440);
  const first1500 = meanVolume(landscapeArtifact.publishedPath, 0.1, 1500);
  const second440 = meanVolume(landscapeArtifact.publishedPath, 1.1, 440);
  const second880 = meanVolume(landscapeArtifact.publishedPath, 1.1, 880);
  assert.ok(first880 > first440 + 8, `${first880} vs ${first440}`);
  assert.ok(first880 > first1500 + 8, `${first880} vs ${first1500}`);
  assert.ok(second440 > second880 + 8, `${second440} vs ${second880}`);

  const cancelable = await fixture.human.createRenderJob(fixture.projectId, {
    allowPlaceholders: false,
    expectedRevision: currentRevision,
    formats: ['landscape'],
  });
  assert.equal(
    (await fixture.human.cancelRenderJob(fixture.projectId, cancelable.id))
      .status,
    'canceled',
  );
  const retry = await fixture.human.retryRenderJob(
    fixture.projectId,
    cancelable.id,
    { expectedProjectRevision: currentRevision },
  );
  assert.equal(retry.retryOfJobId, cancelable.id);

  const interrupted = await fixture.human.createRenderJob(fixture.projectId, {
    allowPlaceholders: false,
    expectedRevision: currentRevision,
    formats: ['landscape'],
  });
  fixture.store.beginRenderJob(fixture.projectId, interrupted.id);
  const failing = await fixture.human.createRenderJob(fixture.projectId, {
    allowPlaceholders: false,
    expectedRevision: currentRevision,
    formats: ['landscape'],
  });
  const selectedAssets = await fixture.human.getAssets(fixture.projectId);
  const managedVideo = selectedAssets.assets.find(
    (asset) => asset.kind === 'video',
  )!;
  await unlink(managedVideo.managedPath);
  const failed = await fixture.human.runRenderJob(
    fixture.projectId,
    failing.id,
  );
  assert.equal(failed.status, 'failed');
  assert.equal(
    createHash('sha256')
      .update(await readFile(landscapeArtifact.publishedPath))
      .digest('hex'),
    landscapeArtifact.checksum,
  );
  await fixture.service.close();
  fixture.store.close();
  const reopened = openProjectStore(fixture.databasePath, {
    managedRoot: fixture.managedRoot,
  });
  const reopenedMedia = reopened.getMediaProject(fixture.projectId);
  assert.equal(
    reopenedMedia.jobs.find((job) => job.id === interrupted.id)?.status,
    'waiting',
  );
  assert.equal(
    reopenedMedia.jobs.find((job) => job.id === completed.id)?.artifacts.length,
    2,
  );
  assert.equal(
    reopenedMedia.jobs.find((job) => job.id === failing.id)?.status,
    'failed',
  );
  assert.equal(
    reopenedMedia.shots.find((shot) => shot.id === reordered.shots[0]!.id)
      ?.overrides.vertical.captionsEnabled,
    true,
  );
  reopened.close();
});
