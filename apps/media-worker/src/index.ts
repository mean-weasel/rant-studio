import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  OutputFormat,
  RenderArtifactSnapshot,
  RenderPlan,
} from '../../../packages/model/src/index.ts';

export type MediaJobEnvelope = {
  baseRevision: number;
  jobId: string;
  kind: 'transcription' | 'preview' | 'render';
  projectId: string;
};

export interface MediaWorkerPort {
  execute(job: MediaJobEnvelope): Promise<void>;
}

type RenderResult = Omit<RenderArtifactSnapshot, 'id'>;

const formats: Record<
  OutputFormat,
  { height: number; width: number }
> = {
  landscape: { height: 1080, width: 1920 },
  vertical: { height: 1920, width: 1080 },
};

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed: ${(result.stderr || result.stdout || '').trim()}`,
    );
  }
}

function checksum(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const glyphs: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '00000', '00100'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
};

function captionImage(
  text: string,
  width: number,
  height: number,
  path: string,
): void {
  const scale = Math.max(3, Math.floor(height / 10));
  const normalized = text.toUpperCase().replace(/[^A-Z0-9 !?.-]/g, ' ');
  const maxCharacters = Math.max(1, Math.floor(width / (6 * scale)));
  const line = normalized.slice(0, maxCharacters);
  const pixels = Buffer.alloc(width * height * 3, 0);
  const startX = Math.max(0, Math.floor((width - line.length * 6 * scale) / 2));
  const startY = Math.max(0, Math.floor((height - 7 * scale) / 2));
  [...line].forEach((character, characterIndex) => {
    const glyph = glyphs[character];
    if (!glyph) return;
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((pixel, columnIndex) => {
        if (pixel !== '1') return;
        for (let y = 0; y < scale; y += 1) {
          for (let x = 0; x < scale; x += 1) {
            const targetX =
              startX + characterIndex * 6 * scale + columnIndex * scale + x;
            const targetY = startY + rowIndex * scale + y;
            if (targetX >= width || targetY >= height) continue;
            const offset = (targetY * width + targetX) * 3;
            pixels[offset] = 255;
            pixels[offset + 1] = 255;
            pixels[offset + 2] = 255;
          }
        }
      });
    });
  });
  writeFileSync(path, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]));
}

function visualFilter(
  plan: RenderPlan['shots'][number],
  format: OutputFormat,
  durationSeconds: number,
): string {
  const { height, width } = formats[format];
  const override = plan.overrides[format];
  const framing =
    override.fit === 'contain'
      ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`
      : `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
  const video =
    `[0:v]${framing},setsar=1,trim=duration=${durationSeconds},` +
    `tpad=stop_mode=clone:stop_duration=${durationSeconds},` +
    `trim=duration=${durationSeconds},setpts=PTS-STARTPTS[base]`;
  const caption = override.captionsEnabled
    ? `;[2:v]scale=${width}:${Math.round(height * 0.16)}[caption];[base][caption]overlay=0:H-h[v]`
    : ';[base]null[v]';
  return `${video}${caption};[1:a]atrim=duration=${durationSeconds},asetpts=PTS-STARTPTS[a]`;
}

function renderSegment(
  plan: RenderPlan,
  shot: RenderPlan['shots'][number],
  format: OutputFormat,
  outputPath: string,
): void {
  const { height, width } = formats[format];
  const durationSeconds = Math.max(0.04, (shot.endMs - shot.startMs) / 1000);
  const visualArgs = shot.selectedAsset
    ? shot.selectedAsset.kind === 'image'
      ? ['-loop', '1', '-framerate', '30', '-i', shot.selectedAsset.path]
      : ['-i', shot.selectedAsset.path]
    : [
        '-f',
        'lavfi',
        '-i',
        `color=c=#332b3f:s=${width}x${height}:r=30:d=${durationSeconds}`,
      ];
  const captionPath = `${outputPath}.caption.ppm`;
  const captionArgs = shot.overrides[format].captionsEnabled
    ? (() => {
        captionImage(
          shot.transcript,
          width,
          Math.round(height * 0.16),
          captionPath,
        );
        return ['-loop', '1', '-framerate', '30', '-i', captionPath];
      })()
    : [];
  run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...visualArgs,
    '-ss',
    String(shot.startMs / 1000),
    '-t',
    String(durationSeconds),
    '-i',
    plan.sourceAudioPath,
    ...captionArgs,
    '-filter_complex',
    visualFilter(shot, format, durationSeconds),
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-t',
    String(durationSeconds),
    '-r',
    '30',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-movflags',
    '+faststart',
    outputPath,
  ]);
}

export function renderProject(
  plan: RenderPlan,
  input: {
    formats: OutputFormat[];
    jobId: string;
    managedRoot: string;
  },
): RenderResult[] {
  const renderParent = join(input.managedRoot, plan.projectId, 'renders');
  const temporaryDirectory = join(renderParent, `.tmp-${input.jobId}`);
  const publishedDirectory = join(renderParent, input.jobId);
  mkdirSync(temporaryDirectory, { recursive: true });
  const totalDurationMs = plan.shots.reduce(
    (total, shot) => total + shot.endMs - shot.startMs,
    0,
  );
  try {
    const results = input.formats.map((format) => {
      const segmentDirectory = join(temporaryDirectory, `${format}-segments`);
      mkdirSync(segmentDirectory, { recursive: true });
      const segmentPaths = plan.shots.map((shot, index) => {
        const path = join(segmentDirectory, `${String(index).padStart(4, '0')}.mp4`);
        renderSegment(plan, shot, format, path);
        return path;
      });
      const concatPath = join(segmentDirectory, 'concat.txt');
      writeFileSync(
        concatPath,
        segmentPaths
          .map((path) => `file '${path.replaceAll("'", "'\\''")}'`)
          .join('\n'),
      );
      const outputPath = join(temporaryDirectory, `${format}.mp4`);
      run('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatPath,
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        outputPath,
      ]);
      rmSync(segmentDirectory, { force: true, recursive: true });
      const dimensions = formats[format];
      return {
        checksum: checksum(outputPath),
        durationMs: totalDurationMs,
        format,
        height: dimensions.height,
        publishedPath: join(publishedDirectory, `${format}.mp4`),
        width: dimensions.width,
      };
    });
    mkdirSync(dirname(publishedDirectory), { recursive: true });
    renameSync(temporaryDirectory, publishedDirectory);
    return results;
  } catch (error) {
    rmSync(temporaryDirectory, { force: true, recursive: true });
    throw error;
  }
}
