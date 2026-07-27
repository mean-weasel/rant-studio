import { expect, test, type Page } from '@playwright/test';

async function openAcceptedLedger(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Propose shots' }).click();
  await page.getByRole('button', { name: 'Ask attached agent' }).click();
  await expect(page.getByText('Staged proposal · project unchanged')).toBeVisible();
  await page.getByRole('button', { name: 'Accept 5 shots' }).click();
  await expect(page.getByText('Shot Ledger')).toBeVisible();
}

test('collaboration output oracle preserves human selection and completes preflight', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await openAcceptedLedger(page);

  await page.getByRole('button', { name: 'Select Shot 02' }).click();
  await page.getByRole('button', { name: 'Select uploaded candidate for Shot 02' }).click();
  await expect(
    page.getByTestId('shot-02').getByText('Selected by you · agent cannot replace'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Select Shot 03' }).click();
  await page.getByLabel('Instruction for attached agent').fill(
    'Find a less literal image about the hidden cost.',
  );
  await page.getByRole('button', { name: 'Send instruction' }).click();
  await expect(page.getByText('Codex is working on Shot 03')).toBeVisible();
  await expect(page.getByText('Candidate attached · awaiting your selection')).toBeVisible();

  await page.getByRole('button', { name: 'Activity' }).click();
  await expect(page.getByRole('heading', { name: 'Agent activity' })).toBeVisible();
  await expect(page.getByText('Find a less literal image about the hidden cost.')).toBeVisible();
  await expect(page.getByText('Added 1 candidate · selection unchanged')).toBeVisible();

  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.getByRole('heading', { name: 'Project history' })).toBeVisible();
  await expect(page.getByText('Shot plan accepted')).toBeVisible();
  await expect(page.getByText('Visual selected for Shot 02')).toBeVisible();

  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('button', { name: 'Open preview' }).click();
  await expect(page.getByRole('heading', { name: 'Assembled preview' })).toBeVisible();
  await expect(page.getByText('Landscape · Captions off')).toBeVisible();
  await page.getByRole('button', { name: 'Vertical 9:16' }).click();
  await expect(page.getByText('Vertical · Captions on')).toBeVisible();
  await page.getByRole('button', { name: 'Contain vertical visual' }).click();
  await page.getByRole('button', { name: 'Landscape 16:9' }).click();
  await expect(page.getByRole('button', { name: 'Cover landscape visual', pressed: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close preview' }).click();

  await page.getByRole('button', { name: 'Export' }).click();
  await expect(page.getByRole('heading', { name: 'Export preflight' })).toBeVisible();
  await expect(page.getByText('3 shots need visuals')).toBeVisible();
  await page.getByRole('button', { name: 'Export anyway' }).click();
  await expect(page.getByRole('heading', { name: 'Confirm placeholder export' })).toBeVisible();
  await page.getByLabel('Include clearly marked placeholder frames').check();
  await page.getByRole('button', { name: 'Render simulated MP4s' }).click();
  await expect(page.getByText('Two mock renders are ready')).toBeVisible();

  expect(consoleErrors).toEqual([]);
});

test('collaboration output supports simulated upload, provenance, and deterministic reset', async ({
  page,
}) => {
  await openAcceptedLedger(page);

  await page.getByRole('button', { name: 'Select Shot 04' }).click();
  await page.getByRole('button', { name: 'Upload files for Shot 04' }).click();
  await expect(page.getByRole('heading', { name: 'Attach a candidate' })).toBeVisible();
  await page.getByRole('button', { name: 'Add demo-still.png' }).click();
  await expect(page.getByText('1 candidate · none selected')).toBeVisible();
  await page.getByRole('button', { name: 'Inspect demo-still.png' }).click();
  await expect(page.getByRole('heading', { name: 'Asset provenance' })).toBeVisible();
  await expect(page.getByText('Human browser upload')).toBeVisible();
  await page.getByRole('button', { name: 'Close asset provenance' }).click();

  await page.getByRole('button', { name: 'Reset demo' }).click();
  await expect(page.getByText('Untouched transcript')).toBeVisible();
  await expect(page.getByText('Shot Ledger')).toHaveCount(0);
});
