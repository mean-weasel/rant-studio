import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { openProjectStore } from '../apps/service/src/store.ts';
import { startLocalService } from '../apps/service/src/server.ts';

test('production intake shows the same persisted narration and timestamp words in the browser', async ({
  page,
}) => {
  const directory = await mkdtemp(
    join(tmpdir(), 'rant-studio-browser-intake-'),
  );
  const store = openProjectStore(join(directory, 'project.db'));
  const credential = store.issueCredential({
    role: 'human',
    scopes: ['project:*'],
  });
  const service = await startLocalService({ port: 0, store });

  try {
    await page.goto('/?mode=intake');
    await page.getByLabel('Local service URL').fill(service.url);
    await page.getByLabel('Local credential').fill(credential.token);
    await page.getByRole('button', { name: 'Connect' }).click();

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

    await page
      .getByRole('button', { name: 'Transcribe deterministically' })
      .click();
    await expect(
      page.getByRole('table', { name: 'Word timestamps' }),
    ).toContainText('Rant');
    await expect(
      page.getByRole('table', { name: 'Word timestamps' }),
    ).toContainText('0–320 ms');
    await expect(page.getByText('Revision 3', { exact: true })).toBeVisible();
  } finally {
    await service.close();
    store.close();
  }
});
