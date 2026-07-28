import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { openProjectStore } from '../apps/service/src/store.ts';
import { startLocalService } from '../apps/service/src/server.ts';
import { RantClient } from '../packages/api/src/index.ts';

const wav = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WAVEfmt '),
  Buffer.alloc(32),
]);

function scaleWords() {
  return Array.from({ length: 150 }, (_, index) => ({
    endMs: (index + 1) * 6_000,
    startMs: index * 6_000,
    text:
      index === 0
        ? `opening-${'x'.repeat(280)}`
        : index === 1
          ? 'https://example.test/a/very/long/commentary/reference?with=unbroken-query-value'
          : index === 2
            ? `visual-${'filename'.repeat(24)}.png`
            : index === 3
              ? '🎙️'.repeat(80)
              : `word-${index + 1}`,
  }));
}

async function openScaleLedger(page: Page) {
  const directory = await mkdtemp(join(tmpdir(), 'rant-studio-scale-'));
  const store = openProjectStore(join(directory, 'project.db'));
  const humanCredential = store.issueCredential({
    role: 'human',
    scopes: ['project:*'],
  });
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
  const words = scaleWords();

  await page.goto('/?mode=intake');
  await page.getByLabel('Local service URL').fill(service.url);
  await page.getByLabel('Local credential').fill(humanCredential.token);
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.getByLabel('Project name').fill('Fifteen Minute Scale');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByLabel('Narration file').setInputFiles({
    buffer: wav,
    mimeType: 'audio/wav',
    name: 'fifteen-minutes.wav',
  });
  await page.getByRole('button', { name: 'Upload narration' }).click();
  await page.getByText('Import timestamp JSON').click();
  await page.getByLabel('Timestamp JSON').fill(JSON.stringify({ words }));
  await page.getByRole('button', { name: 'Import transcript' }).click();
  const projectId = (await page.locator('.intake-project code').textContent())!;

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
    constraints: { targetShotCount: 150 },
    expectedRevision: editorial.revision,
    instruction: 'Create 150 chronological shots.',
    pacing: 'Standard',
  });
  const session = await agent.attachAgent(projectId);
  await agent.claimProposalTask(projectId, task.id, session.id);
  const proposal = await agent.submitShotProposal(projectId, task.id, {
    baseProjectRevision: editorial.revision,
    baseTranscriptRevisionId: editorial.effectiveTranscript.id,
    shots: words.map((_, index) => ({
      endWordOrdinal: index,
      rationale: `Keep scale beat ${index + 1} independently reachable.`,
      startWordOrdinal: index,
      theme: `Scale beat ${index + 1}`,
    })),
  });
  await human.acceptShotProposal(projectId, proposal.id, {
    expectedRevision: editorial.revision,
  });

  await page.getByRole('button', { name: 'Open editorial workspace' }).click();
  await expect(page.getByText('150 stable shots')).toBeVisible();
  const loadStarted = Date.now();
  await page
    .getByRole('button', { name: 'Open production Shot Ledger' })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Showing 150 of 150' }),
  ).toBeVisible();
  const loadMs = Date.now() - loadStarted;

  return {
    agent,
    agentCredential,
    human,
    loadMs,
    projectId,
    service,
    store,
  };
}

test('150-shot scale performance windows rows and preserves live interaction state', async ({
  page,
}) => {
  const fixture = await openScaleLedger(page);
  try {
    expect(fixture.loadMs).toBeLessThan(2_000);
    const ledgerWindow = page.getByRole('list', {
      name: 'Windowed Shot Ledger',
    });
    await expect(ledgerWindow).toHaveAttribute('data-total-shots', '150');
    await expect(ledgerWindow).toHaveAttribute('data-rendered-shots', '20');
    await expect(ledgerWindow.locator(':scope > li')).toHaveCount(20);

    const searchStarted = Date.now();
    await page.getByLabel('Search shots').fill('Scale beat 149');
    await expect(
      page.getByRole('status').filter({ hasText: 'Showing 1 of 150' }),
    ).toBeVisible();
    await expect(ledgerWindow).toContainText('Scale beat 149');
    expect(Date.now() - searchStarted).toBeLessThan(500);
    await page.getByLabel('Search shots').fill('');
    await expect(
      page.getByRole('status').filter({ hasText: 'Showing 150 of 150' }),
    ).toBeVisible();

    await ledgerWindow.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(ledgerWindow.locator(':scope > li')).toHaveCount(20);
    await expect(ledgerWindow).toContainText('Scale beat 150');
    const scrollBefore = await ledgerWindow.evaluate(
      (element) => element.scrollTop,
    );
    expect(scrollBefore).toBeGreaterThan(1_000);

    await page.getByLabel('Checkpoint name').fill('Unsaved scale draft');
    const rows = ledgerWindow.locator(':scope > li');
    const rowCount = await rows.count();
    await rows.nth(rowCount - 1).click();
    const selectedId = await rows
      .nth(rowCount - 1)
      .locator('code')
      .textContent();

    const ledger = await fixture.human.getLedger(fixture.projectId);
    await fixture.human.createAssetTask(fixture.projectId, {
      expectedRevision: ledger.revision,
      instruction: 'Live task must not move the creator.',
      shotIds: [ledger.shots.at(-1)!.id],
    });
    await page.getByRole('button', { name: 'Refresh live state' }).click();
    await expect(page.getByLabel('Checkpoint name')).toHaveValue(
      'Unsaved scale draft',
    );
    expect(
      await ledgerWindow.evaluate((element) => element.scrollTop),
    ).toBeGreaterThanOrEqual(scrollBefore - 2);
    await expect(
      ledgerWindow.locator('li[data-selected="true"] code'),
    ).toHaveText(selectedId ?? '');
    await page.getByLabel('Task state').selectOption('active');
    await expect(
      page.getByRole('status').filter({ hasText: 'Showing 1 of 150' }),
    ).toBeVisible();
    await page.getByLabel('Task state').selectOption('all');
    await page.getByRole('button', { name: 'Jump to current shot' }).click();
    await expect(
      ledgerWindow.locator('li[data-selected="true"]'),
    ).toBeFocused();
  } finally {
    await fixture.service.close();
    fixture.store.close();
  }
});

test('responsive overflow a11y keeps transcript, ledger, and candidate windows bounded', async ({
  page,
}) => {
  const fixture = await openScaleLedger(page);
  try {
    const transcriptWindows = page.locator('.transcript-word-window');
    const transcriptWindowCount = await transcriptWindows.count();
    expect(transcriptWindowCount).toBeGreaterThanOrEqual(3);
    for (let index = 0; index < transcriptWindowCount; index += 1) {
      expect(
        Number(
          await transcriptWindows
            .nth(index)
            .getAttribute('data-rendered-words'),
        ),
      ).toBeLessThanOrEqual(40);
      expect(
        Number(
          await transcriptWindows.nth(index).getAttribute('data-total-words'),
        ),
      ).toBe(150);
    }
    await page
      .getByLabel('Find in corrected working transcript')
      .fill('word-149');
    await expect(
      page
        .getByRole('region', { name: 'Corrected working transcript' })
        .getByRole('status'),
    ).toContainText('1 matches');
    await expect(
      page.getByRole('region', { name: 'Corrected working transcript' }),
    ).toContainText('888000–894000 ms');
    await page.getByRole('button', { name: 'word-149' }).click();
    await expect(page.getByText('Selected word 149')).toBeVisible();

    const ledger = await fixture.human.getLedger(fixture.projectId);
    let revision = ledger.revision;
    for (let index = 0; index < 8; index += 1) {
      const next = await fixture.agent.uploadVisualCandidate(
        fixture.projectId,
        {
          bytesBase64: Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Buffer.alloc(30),
            Buffer.from([index + 1, index + 21]),
          ]).toString('base64'),
          expectedRevision: revision,
          mimeType: 'image/png',
          originalName: `candidate-${index}-${'long-filename'.repeat(20)}.png`,
          shotIds: [ledger.shots[0]!.id],
        },
      );
      revision = next.revision;
    }

    await page.getByRole('button', { name: 'Open visual workspace' }).click();
    await page.setViewportSize({ width: 320, height: 800 });
    await expect(page.getByLabel('Search shots')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Jump to first incomplete' }),
    ).toBeVisible();
    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      offenders: [...document.querySelectorAll<HTMLElement>('body *')]
        .filter(
          (element) =>
            element.getBoundingClientRect().right >
            document.documentElement.clientWidth + 1,
        )
        .slice(0, 12)
        .map((element) => ({
          className: element.className,
          right: element.getBoundingClientRect().right,
          tag: element.tagName,
          text: element.textContent?.slice(0, 50),
          width: element.getBoundingClientRect().width,
        })),
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(
      dimensions.scrollWidth,
      JSON.stringify(dimensions.offenders, null, 2),
    ).toBe(dimensions.clientWidth);

    const candidateTray = page.locator('.candidate-tray').first();
    await expect(candidateTray).toBeVisible();
    const trayDimensions = await candidateTray.evaluate((element) => ({
      clientWidth: element.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
      scrollWidth: element.scrollWidth,
    }));
    expect(trayDimensions.scrollWidth).toBeGreaterThan(
      trayDimensions.clientWidth,
    );
    expect(['auto', 'scroll']).toContain(trayDimensions.overflowX);

    const ledgerWindow = page.getByRole('list', {
      name: 'Windowed Shot Ledger',
    });
    await expect(ledgerWindow.locator(':scope > li')).toHaveCount(20);
    await expect(ledgerWindow.locator(':scope > li').first()).toHaveAttribute(
      'aria-setsize',
      '150',
    );
    await page.getByLabel('Search shots').focus();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Visual state')).toBeFocused();
  } finally {
    await fixture.service.close();
    fixture.store.close();
  }
});
