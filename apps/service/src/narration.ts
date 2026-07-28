import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { extname, join } from 'node:path';

export type NarrationMedia = {
  extension: '.mp3' | '.mp4' | '.wav';
  mimeType: 'audio/mpeg' | 'audio/wav' | 'video/mp4';
};

export type ManagedNarration = {
  checksum: string;
  managedPath: string;
  normalizedChecksum: string;
  normalizedMimeType: 'audio/wav';
  originalPath: string;
};

export type VisualMedia = {
  extension: '.mp4' | '.png';
  kind: 'image' | 'video';
};

export class MediaIntakeError extends Error {
  constructor(
    readonly code: 'MEDIA_TOOL_UNAVAILABLE' | 'UNSUPPORTED_MEDIA',
    message: string,
  ) {
    super(message);
    this.name = 'MediaIntakeError';
  }
}

function checksum(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Cleanup is best effort; the primary validation error is more useful.
  }
}

function hasMp3Signature(bytes: Buffer): boolean {
  return (
    bytes.subarray(0, 3).toString('ascii') === 'ID3' ||
    (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
  );
}

export function narrationMedia(
  bytes: Buffer,
  name: string,
  mimeType: string,
): NarrationMedia {
  const extension = extname(name).toLowerCase();
  if (
    extension === '.wav' &&
    ['audio/wav', 'audio/x-wav'].includes(mimeType) &&
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    return { extension, mimeType: 'audio/wav' };
  }
  if (
    extension === '.mp3' &&
    ['audio/mpeg', 'audio/mp3'].includes(mimeType) &&
    hasMp3Signature(bytes)
  ) {
    return { extension, mimeType: 'audio/mpeg' };
  }
  if (
    extension === '.mp4' &&
    mimeType === 'video/mp4' &&
    bytes.length >= 12 &&
    bytes.subarray(4, 8).toString('ascii') === 'ftyp'
  ) {
    return { extension, mimeType: 'video/mp4' };
  }
  throw new MediaIntakeError(
    'UNSUPPORTED_MEDIA',
    'Narration must be a valid WAV, MP3, or MP4 file with matching media bytes',
  );
}

export function narrationMimeTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.mp3':
      return 'audio/mpeg';
    case '.mp4':
      return 'video/mp4';
    case '.wav':
      return 'audio/wav';
    default:
      return 'application/octet-stream';
  }
}

export function persistNarration(input: {
  bytes: Buffer;
  directory: string;
  id: string;
  media: NarrationMedia;
}): ManagedNarration {
  mkdirSync(input.directory, { recursive: true });
  const originalPath = join(
    input.directory,
    `${input.id}${input.media.extension}`,
  );
  const originalTemporaryPath = `${originalPath}.partial`;
  writeFileSync(originalTemporaryPath, input.bytes, { flag: 'wx' });
  renameSync(originalTemporaryPath, originalPath);

  if (input.media.extension === '.wav') {
    const sourceChecksum = checksum(input.bytes);
    return {
      checksum: sourceChecksum,
      managedPath: originalPath,
      normalizedChecksum: sourceChecksum,
      normalizedMimeType: 'audio/wav',
      originalPath,
    };
  }

  const managedPath = join(input.directory, `${input.id}.wav`);
  const normalizedTemporaryPath = `${managedPath}.partial`;
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      originalPath,
      '-map',
      '0:a:0',
      '-vn',
      '-ac',
      '2',
      '-ar',
      '48000',
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      normalizedTemporaryPath,
    ],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.error) {
    remove(originalPath);
    remove(normalizedTemporaryPath);
    throw new MediaIntakeError(
      'MEDIA_TOOL_UNAVAILABLE',
      `FFmpeg could not normalize narration: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    remove(originalPath);
    remove(normalizedTemporaryPath);
    throw new MediaIntakeError(
      'UNSUPPORTED_MEDIA',
      `Narration has no decodable audio stream: ${(result.stderr || result.stdout).trim()}`,
    );
  }

  const normalizedBytes = readFileSync(normalizedTemporaryPath);
  if (
    normalizedBytes.length < 12 ||
    normalizedBytes.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    normalizedBytes.subarray(8, 12).toString('ascii') !== 'WAVE'
  ) {
    remove(originalPath);
    remove(normalizedTemporaryPath);
    throw new MediaIntakeError(
      'UNSUPPORTED_MEDIA',
      'FFmpeg did not produce valid WAV narration',
    );
  }
  renameSync(normalizedTemporaryPath, managedPath);
  return {
    checksum: checksum(input.bytes),
    managedPath,
    normalizedChecksum: checksum(normalizedBytes),
    normalizedMimeType: 'audio/wav',
    originalPath,
  };
}

export function removeManagedNarration(narration: ManagedNarration): void {
  remove(narration.originalPath);
  if (narration.managedPath !== narration.originalPath) {
    remove(narration.managedPath);
  }
}

export function visualMedia(
  bytes: Buffer,
  name: string,
  mimeType: string,
): VisualMedia {
  const pngSignature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (
    extname(name).toLowerCase() === '.png' &&
    mimeType === 'image/png' &&
    bytes.length >= pngSignature.length &&
    bytes.subarray(0, pngSignature.length).equals(pngSignature)
  ) {
    return { extension: '.png', kind: 'image' };
  }
  if (
    extname(name).toLowerCase() === '.mp4' &&
    mimeType === 'video/mp4' &&
    bytes.length >= 12 &&
    bytes.subarray(4, 8).toString('ascii') === 'ftyp'
  ) {
    return { extension: '.mp4', kind: 'video' };
  }
  throw new MediaIntakeError(
    'UNSUPPORTED_MEDIA',
    'Version one visual intake supports PNG images and MP4 video',
  );
}
