import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { openProjectStore } from '../apps/service/src/store.ts';
import { startLocalService } from '../apps/service/src/server.ts';

test('production intake shows the same persisted narration and timestamp words in the browser', async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'rant-studio-browser-intake-'));
  const store = openProjectStore(join(directory, 'project.db'));
  const credential = store.issueCredential({ role: 'human', scopes: ['project:*'] });
  const service = await startLocalService({ port: 0, store });

  try {
    await page.goto('/?mode=intake');
    await page.getByLabel('Local service URL').fill(service.url);
    await page.getByLabel('Local credential').fill(credential.token);
    await page.getByRole('button', { name: 'Connect' }).click();

    await page.getByLabel('Project name').fill('Browser Intake');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('heading', { name: 'Browser Intake' })).toBeVisible();

    await page.getByLabel('Narration WAV').setInputFiles({
      buffer: Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.alloc(4),
        Buffer.from('WAVEfmt '),
        Buffer.alloc(32),
      ]),
      mimeType: 'audio/wav',
      name: 'narration.wav',
    });
    await page.getByRole('button', { name: 'Upload narration' }).click();
    await expect(page.getByText('narration.wav')).toBeVisible();

    await page.getByRole('button', { name: 'Transcribe deterministically' }).click();
    await expect(page.getByRole('table', { name: 'Word timestamps' })).toContainText(
      'Rant',
    );
    await expect(page.getByRole('table', { name: 'Word timestamps' })).toContainText(
      '0–320 ms',
    );
    await expect(page.getByText('Revision 3', { exact: true })).toBeVisible();
  } finally {
    await service.close();
    store.close();
  }
});
