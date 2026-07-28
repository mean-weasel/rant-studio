import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { openProjectStore } from '../apps/service/src/store.ts';
import { startLocalService } from '../apps/service/src/server.ts';
import { RantClient } from '../packages/api/src/index.ts';

test('production preview preflight export render rechecks stale authority and plays artifact', async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'rant-studio-browser-media-'));
  const audioPath = join(directory, 'narration.wav');
  const generated = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1:sample_rate=48000',
      '-c:a',
      'pcm_s16le',
      audioPath,
    ],
    { encoding: 'utf8' },
  );
  expect(generated.status, generated.stderr).toBe(0);
  const store = openProjectStore(join(directory, 'project.db'), {
    managedRoot: join(directory, 'managed'),
  });
  const humanCredential = store.issueCredential({
    role: 'human',
    scopes: ['project:*'],
  });
  const agentCredential = store.issueCredential({
    role: 'agent',
    scopes: ['project:read', 'task:claim', 'proposal:write'],
  });
  const service = await startLocalService({ port: 0, store });
  try {
    await page.goto('/?mode=intake');
    await page.getByLabel('Local service URL').fill(service.url);
    await page.getByLabel('Local credential').fill(humanCredential.token);
    await page.getByRole('button', { name: 'Connect' }).click();
    await page.getByLabel('Project name').fill('Browser Media');
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByLabel('Narration file').setInputFiles({
      buffer: await readFile(audioPath),
      mimeType: 'audio/wav',
      name: 'narration.wav',
    });
    await page.getByRole('button', { name: 'Upload narration' }).click();
    await page.getByText('Import timestamp JSON').click();
    await page.getByLabel('Timestamp JSON').fill(
      JSON.stringify({
        words: [{ endMs: 1000, startMs: 0, text: 'Placeholder narration' }],
      }),
    );
    await page.getByRole('button', { name: 'Import transcript' }).click();
    const projectId = (await page
      .locator('.intake-project code')
      .textContent())!;

    const human = new RantClient({
      baseUrl: service.url,
      credential: humanCredential.token,
    });
    const agent = new RantClient({
      baseUrl: service.url,
      credential: agentCredential.token,
    });
    const editorial = await human.getEditorial(projectId);
    const task = await human.createProposalTask(projectId, {
      constraints: {},
      expectedRevision: editorial.revision,
      instruction: 'One shot.',
      pacing: 'Standard',
    });
    const session = await agent.attachAgent(projectId);
    await agent.claimProposalTask(projectId, task.id, session.id);
    const proposal = await agent.submitShotProposal(projectId, task.id, {
      baseProjectRevision: editorial.revision,
      baseTranscriptRevisionId: editorial.effectiveTranscript.id,
      shots: [
        {
          endWordOrdinal: 0,
          rationale: 'One complete spoken beat.',
          startWordOrdinal: 0,
          theme: 'Opening',
        },
      ],
    });
    await human.acceptShotProposal(projectId, proposal.id, {
      expectedRevision: editorial.revision,
    });

    await page
      .getByRole('button', { name: 'Open editorial workspace' })
      .click();
    await page
      .getByRole('button', { name: 'Open production Shot Ledger' })
      .click();
    await page.getByRole('button', { name: 'Open preview and export' }).click();
    await expect(
      page.getByText('MISSING VISUAL', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('1 incomplete shots')).toBeVisible();
    await page
      .getByRole('button', { name: 'Return to this ledger shot' })
      .click();
    await expect(
      page.getByRole('list', { name: 'Windowed Shot Ledger' }).locator('li'),
    ).toBeFocused();

    const landscape = page.getByRole('group', { name: '16:9 landscape' });
    await landscape.getByLabel('Fit').selectOption('contain');
    await expect(
      page.getByRole('status').filter({ hasText: 'landscape settings saved' }),
    ).toBeVisible();
    await page.waitForTimeout(750);
    await expect(
      page.getByRole('status').filter({ hasText: 'landscape settings saved' }),
    ).toBeVisible();
    await expect(landscape.getByLabel('Fit')).toHaveValue('contain');
    await page
      .getByLabel('I authorize unmistakable placeholders for incomplete shots')
      .check();

    const media = await human.getMedia(projectId);
    await human.mutateProject(projectId, {
      expectedRevision: media.revision,
      operation: 'add_note',
      payload: { note: 'Invalidate the open preflight.' },
    });
    await expect(
      page.getByRole('status').filter({ hasText: 'stale' }),
    ).toBeVisible();
    await expect(
      page.getByLabel(
        'I authorize unmistakable placeholders for incomplete shots',
      ),
    ).not.toBeChecked();
    await page.getByRole('button', { name: 'Recheck revision' }).click();
    await page
      .getByLabel('I authorize unmistakable placeholders for incomplete shots')
      .check();
    await page.getByRole('button', { name: 'Render selected formats' }).click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Render succeeded with 2 artifacts' }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('video.render-preview')).toBeVisible();
    await expect(page.getByLabel('Render jobs')).toContainText(
      'succeeded · revision',
    );
  } finally {
    await service.close();
    store.close();
  }
});
