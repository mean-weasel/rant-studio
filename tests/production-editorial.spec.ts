import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { openProjectStore } from '../apps/service/src/store.ts';
import { startLocalService } from '../apps/service/src/server.ts';
import { RantClient } from '../packages/api/src/index.ts';

test('production transcript proposal Shot Ledger asset candidate agent activity preserves human authority', async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'rant-studio-browser-editorial-'));
  const store = openProjectStore(join(directory, 'project.db'));
  const humanCredential = store.issueCredential({ role: 'human', scopes: ['project:*'] });
  const agentCredential = store.issueCredential({
    role: 'agent',
    scopes: [
      'project:read',
      'task:claim',
      'proposal:write',
      'asset:add',
      'asset:recommend',
    ],
  });
  const service = await startLocalService({ port: 0, store });

  try {
    await page.goto('/?mode=intake');
    await page.getByLabel('Local service URL').fill(service.url);
    await page.getByLabel('Local credential').fill(humanCredential.token);
    await page.getByRole('button', { name: 'Connect' }).click();
    await page.getByLabel('Project name').fill('Production Editorial');
    await page.getByRole('button', { name: 'Create project' }).click();
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
    await page.getByText('Import timestamp JSON').click();
    await page.getByLabel('Timestamp JSON').fill(
      JSON.stringify({
        words: [
          { endMs: 200, startMs: 0, text: 'Every' },
          { endMs: 400, startMs: 200, text: 'app' },
          { endMs: 600, startMs: 400, text: 'thinks' },
          { endMs: 800, startMs: 600, text: 'it' },
          { endMs: 1000, startMs: 800, text: 'is' },
          { endMs: 1200, startMs: 1000, text: 'special' },
        ],
      }),
    );
    await page.getByRole('button', { name: 'Import transcript' }).click();
    await page.getByRole('button', { name: 'Open editorial workspace' }).click();

    await page.getByLabel('Word', { exact: true }).selectOption({ index: 1 });
    await page.getByLabel('Replacement').fill('application');
    await page.getByRole('button', { name: 'Save correction' }).click();
    await expect(
      page.getByRole('article').filter({ hasText: 'Raw provider transcript' }),
    ).toContainText('Every app thinks');
    await expect(
      page.getByRole('article').filter({ hasText: 'Corrected working transcript' }),
    ).toContainText('Every application thinks');

    await page.getByLabel('Pacing').selectOption('Punchy');
    await page.getByLabel('Starting shots').fill('3');
    const projectId = (await page.locator('.intake-project code').textContent())!;
    const agent = new RantClient({
      baseUrl: service.url,
      credential: agentCredential.token,
    });
    const agentSession = await agent.attachAgent(projectId);
    async function submitExternalProposal() {
      const editorial = await agent.getEditorial(projectId);
      const activity = await agent.getActivity(projectId, { status: 'queued' });
      const task = activity.tasks.find((candidate) => candidate.kind === 'proposal')!;
      await agent.claimTask(projectId, task.id, { sessionId: agentSession.id });
      await agent.submitShotProposal(projectId, task.id, {
        baseProjectRevision: task.baseRevision,
        baseTranscriptRevisionId: editorial.effectiveTranscript.id,
        shots: [
          { endWordOrdinal: 1, rationale: 'Open.', startWordOrdinal: 0, theme: 'Open' },
          { endWordOrdinal: 3, rationale: 'Middle.', startWordOrdinal: 2, theme: 'Middle' },
          { endWordOrdinal: 5, rationale: 'Close.', startWordOrdinal: 4, theme: 'Close' },
        ],
      });
    }
    await page.getByRole('button', { name: 'Queue external shot proposal' }).click();
    await submitExternalProposal();

    await expect(page.getByText('Agent result · ready for review')).toBeVisible();
    await expect(page.locator('.proposal-review article')).toHaveCount(3);
    await expect(page.locator('.proposal-chunk').first()).toContainText(
      'Every application',
    );
    await page.getByRole('button', { name: 'Move boundary later' }).first().click();
    await expect(
      page.getByRole('status').filter({ hasText: 'exact coverage revalidated' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Reject proposal' }).click();
    await expect(page.getByRole('button', { name: 'Queue regenerated external proposal' })).toBeVisible();
    await page.getByRole('button', { name: 'Queue regenerated external proposal' }).click();
    await submitExternalProposal();
    await expect(page.getByText('Agent result · ready for review')).toBeVisible();
    await page.getByRole('button', { name: 'Accept shots' }).click();
    await expect(page.getByText('Accepted shot ledger', { exact: true })).toBeVisible();
    await expect(page.getByText('3 stable shots')).toBeVisible();
    await page.getByRole('button', { name: 'Open production Shot Ledger' }).click();
    await page.getByLabel('Checkpoint name').fill('Before edits');
    await page.getByRole('button', { name: 'Name checkpoint' }).click();
    await expect(page.getByRole('button', { name: 'Restore Before edits' })).toBeVisible();

    await page.getByRole('button', { name: 'Move up' }).nth(1).click();
    await expect(page.getByRole('status').filter({ hasText: 'Shot moved' })).toBeVisible();

    await page.getByRole('button', { name: 'Split' }).first().click();
    await expect(page.locator('.production-ledger-rows > li')).toHaveCount(4);
    await page.getByRole('button', { name: 'Undo last ledger edit' }).click();
    await expect(page.locator('.production-ledger-rows > li')).toHaveCount(3);
    await page.getByRole('button', { name: 'Restore Before edits' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Restored' })).toBeVisible();

    await page.getByRole('button', { name: 'Open visual workspace' }).click();
    await page.getByRole('button', { name: 'Refresh candidates' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Visual workspace loaded' })).toBeVisible();
    await page
      .getByRole('group', { name: 'Explicit shot targets' })
      .getByRole('checkbox')
      .nth(1)
      .check();
    await page.getByLabel('Visual candidate (PNG or MP4)').setInputFiles({
      buffer: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(32),
      ]),
      mimeType: 'image/png',
      name: 'human.png',
    });
    await page.getByRole('button', { name: 'Upload to selected shots' }).click();
    await expect(page.getByText('1 candidate', { exact: true })).toHaveCount(2);
    await page.getByRole('button', { name: 'Use this visual' }).first().click();
    await expect(
      page.getByRole('button', { name: 'Selected', exact: true }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Ask agent' }).nth(1).click();
    await expect(page.getByLabel('Agent instruction')).toHaveValue(
      'Find a visual candidate for Shot 2.',
    );
    await expect(page.getByLabel('Agent task targets')).toContainText('Shot 2');
    await page.getByRole('button', { name: 'Dispatch task to CLI agent' }).click();
    await expect(page.getByText(/queued · asset/)).toBeVisible();

    const activity = await agent.getActivity(projectId, { status: 'queued' });
    const assetTask = activity.tasks[0]!;
    await agent.claimTask(projectId, assetTask.id, { sessionId: agentSession.id });
    await agent.transitionTask(projectId, assetTask.id, {
      expectedProjectRevision: assetTask.baseRevision,
      idempotencyKey: 'browser-running',
      status: 'running',
    });
    const agentAsset = await agent.uploadVisualCandidate(projectId, {
      bytesBase64: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(31),
        Buffer.from([1]),
      ]).toString('base64'),
      expectedRevision: assetTask.baseRevision,
      mimeType: 'image/png',
      originalName: 'agent.png',
      shotIds: assetTask.shotIds,
      taskId: assetTask.id,
    });
    await agent.transitionTask(projectId, assetTask.id, {
      expectedProjectRevision: agentAsset.revision,
      idempotencyKey: 'browser-success',
      status: 'succeeded',
      summary: 'Agent attached a second candidate without changing selection.',
    });
    let latestAssets = await agent.recommendVisual(projectId, {
      assetId: agentAsset.assets.at(-1)!.id,
      expectedRevision: agentAsset.revision,
      reason: 'The second image is a stronger match for this shot.',
      shotId: assetTask.shotIds[0]!,
    });
    for (let index = 0; index < 6; index += 1) {
      latestAssets = await agent.uploadVisualCandidate(projectId, {
        bytesBase64: Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.alloc(30),
          Buffer.from([index + 20, index + 40]),
        ]).toString('base64'),
        expectedRevision: latestAssets.revision,
        mimeType: 'image/png',
        originalName: `agent-${index}.png`,
        shotIds: assetTask.shotIds,
      });
    }

    await expect(page.getByText('8 candidates', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Selected', exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/succeeded · asset/)).toBeVisible();
    await expect(
      page.getByText('Agent attached a second candidate without changing selection.'),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Agent recommends: The second image is a stronger match for this shot.',
      ),
    ).toBeVisible();
    const liveTray = page.locator('.candidate-tray').nth(1);
    const candidateCountBefore = await liveTray.locator(':scope > div').count();
    await liveTray.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    const scrollBefore = await liveTray.evaluate((element) => element.scrollLeft);
    expect(scrollBefore).toBeGreaterThan(0);
    const checkpointDraft = page.getByLabel('Checkpoint name');
    await checkpointDraft.fill('Unsaved during live agent work');
    await checkpointDraft.focus();
    await checkpointDraft.evaluate((element) => {
      (element as HTMLInputElement).setSelectionRange(8, 14);
    });
    const selectedLedgerId = await page
      .locator('.production-ledger-rows > li[data-selected="true"] code')
      .textContent();
    await agent.uploadVisualCandidate(projectId, {
      bytesBase64: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(30),
        Buffer.from([99, 100]),
      ]).toString('base64'),
      expectedRevision: latestAssets.revision,
      mimeType: 'image/png',
      originalName: 'agent-live.png',
      shotIds: assetTask.shotIds,
    });
    await expect(liveTray.locator(':scope > div')).toHaveCount(candidateCountBefore + 1);
    expect(await liveTray.evaluate((element) => element.scrollLeft)).toBeGreaterThanOrEqual(
      scrollBefore - 1,
    );
    await expect(checkpointDraft).toHaveValue('Unsaved during live agent work');
    await expect(checkpointDraft).toBeFocused();
    expect(await checkpointDraft.evaluate((element) => (element as HTMLInputElement).selectionStart))
      .toBe(8);
    expect(await checkpointDraft.evaluate((element) => (element as HTMLInputElement).selectionEnd))
      .toBe(14);
    await expect(
      page.locator('.production-ledger-rows > li[data-selected="true"] code'),
    ).toHaveText(selectedLedgerId ?? '');
  } finally {
    await service.close();
    store.close();
  }
});

test('production browser never accepts an external-agent credential', async ({ page }) => {
  await page.goto('/?mode=intake');
  await expect(page.getByLabel('Agent credential')).toHaveCount(0);
});
