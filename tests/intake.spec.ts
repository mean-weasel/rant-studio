import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { TranscriptionCredentialRegistry } from '../apps/service/src/credential-store.ts';
import { openProviderMetadataStore } from '../apps/service/src/provider-metadata.ts';
import { openProjectStore } from '../apps/service/src/store.ts';
import { startLocalService } from '../apps/service/src/server.ts';
import { MemorySecretStore } from './helpers/memory-secret-store.ts';

test('production intake provider credentials and timestamp words stay shared and redacted', async ({
  page,
}) => {
  const directory = await mkdtemp(
    join(tmpdir(), 'rant-studio-browser-intake-'),
  );
  const databasePath = join(directory, 'project.db');
  const store = openProjectStore(databasePath);
  const metadata = openProviderMetadataStore(databasePath);
  const secrets = new MemorySecretStore();
  const registry = new TranscriptionCredentialRegistry({
    fetch: (async () =>
      new Response('{"data":[]}', { status: 200 })) as typeof fetch,
    metadata,
    secretStore: secrets,
  });
  const service = await startLocalService({
    credentialRegistry: registry,
    port: 0,
    store,
  });

  try {
    await page.goto(`/?mode=intake&service=${encodeURIComponent(service.url)}`);
    await expect(page.getByText('Local workspace ready.')).toBeVisible();

    await expect(
      page.getByRole('heading', { name: 'Transcription providers' }),
    ).toBeVisible();
    const canary = 'BROWSER-CANARY-never-persist';
    const groqKey = page.getByLabel('Groq API key');
    await expect(groqKey).toHaveAttribute('type', 'password');
    await groqKey.fill(canary);
    await page.getByRole('button', { name: 'Save Groq key' }).click();
    await expect(groqKey).toHaveValue('');
    await expect(page.getByText('Active: groq · keychain')).toBeVisible();
    expect((await page.content()).includes(canary)).toBe(false);
    expect(
      await page.evaluate(
        (secret) =>
          Object.values({ ...localStorage, ...sessionStorage }).some((value) =>
            String(value).includes(secret),
          ),
        canary,
      ),
    ).toBe(false);
    await page.getByRole('button', { name: 'Test Groq' }).click();
    await expect(page.getByText('valid', { exact: true })).toBeVisible();
    await groqKey.fill(`${canary}-rotated`);
    await page.getByRole('button', { name: 'Replace Groq key' }).click();
    await expect(groqKey).toHaveValue('');
    await page.getByRole('button', { name: 'Remove saved Groq key' }).click();
    await expect(
      page.getByText('Remove this saved Keychain credential?'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Confirm remove' }).click();
    await expect(page.getByText('Active: deterministic')).toBeVisible();

    await page.getByLabel('Project name').fill('Browser Intake');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(
      page.getByRole('heading', { name: 'Browser Intake' }),
    ).toBeVisible();

    const mp3Path = join(directory, 'narration.mp3');
    const ffmpeg = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=520:duration=0.4',
        '-c:a',
        'libmp3lame',
        mp3Path,
      ],
      { encoding: 'utf8' },
    );
    expect(ffmpeg.status, ffmpeg.stderr || ffmpeg.stdout).toBe(0);
    const narrationInput = page.getByLabel('Narration file');
    await expect(narrationInput).toHaveAttribute(
      'accept',
      '.wav,.mp3,.mp4,audio/wav,audio/mpeg,video/mp4',
    );
    await narrationInput.setInputFiles({
      mimeType: 'audio/mpeg',
      name: 'narration.mp3',
      buffer: await import('node:fs/promises').then(({ readFile }) =>
        readFile(mp3Path),
      ),
    });
    await page.getByRole('button', { name: 'Upload narration' }).click();
    await expect(page.getByText('narration.mp3')).toBeVisible();
    await expect(page.getByText('audio/mpeg')).toBeVisible();
    await expect(page.getByText('48 kHz PCM WAV')).toBeVisible();

    await page.getByRole('button', { name: 'Transcribe narration' }).click();
    await expect(
      page.getByRole('table', { name: 'Word timestamps' }),
    ).toContainText('Rant');
    await expect(
      page.getByRole('table', { name: 'Word timestamps' }),
    ).toContainText('0–320 ms');
    await expect(page.getByText('Revision 3', { exact: true })).toBeVisible();
  } finally {
    await service.close();
    metadata.close();
    store.close();
  }
});
