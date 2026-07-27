import { expect, test } from '@playwright/test';

test('proposal review shows the source transcript chunk for every shot', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Propose shots' }).click();
  await page.getByRole('button', { name: 'Ask attached agent' }).click();

  await expect(page.getByText('Staged proposal · project unchanged')).toBeVisible();
  await expect(page.getByText('Transcript chunk', { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      'The strange thing about subscription fatigue is that every app thinks it’s the exception.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Every one of them arrives with a tiny promise: this will make your life simpler.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      'But stack enough tiny conveniences together and suddenly you have another utility bill.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      'The price is not just money. It is the low hum of remembering what renews when.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText('Maybe the premium feature we actually need is an ending.', { exact: true }),
  ).toBeVisible();
});

test('proposal review stacks transcript chunks without narrow-screen overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Propose shots' }).click();
  await page.getByRole('button', { name: 'Ask attached agent' }).click();

  await expect(page.getByText('Staged proposal · project unchanged')).toBeVisible();
  await expect(page.getByText('Transcript chunk', { exact: true })).toBeHidden();
  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBe(layout.clientWidth);
});

test('editorial core keeps the transcript raw until a staged proposal is accepted', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Rant Studio' })).toBeVisible();
  await expect(page.getByText('Untouched transcript')).toBeVisible();
  await expect(page.getByText('Shot 01')).toHaveCount(0);

  await page.getByRole('button', { name: 'Correct transcript' }).click();
  await page.getByLabel('Corrected transcript text').fill(
    'The strange thing about subscription fatigue is that every app thinks it is the exception.',
  );
  await page.getByRole('button', { name: 'Save correction' }).click();
  await expect(page.getByText('Corrected · timing unchanged')).toBeVisible();

  await page.getByRole('button', { name: 'Propose shots' }).click();
  await expect(page.getByRole('heading', { name: 'Propose chronological shots' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Standard' })).toBeChecked();
  await expect(page.getByText('Advanced constraints')).toBeVisible();

  await page.getByRole('button', { name: 'Ask attached agent' }).click();
  await expect(page.getByText('Codex is reading 84 timestamped words')).toBeVisible();
  await expect(page.getByText('Staged proposal · project unchanged')).toBeVisible();
  await expect(
    page.getByText(
      'The strange thing about subscription fatigue is that every app thinks it is the exception.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText('Shot 01')).toHaveCount(0);

  const firstEnd = page.getByLabel('Shot 1 end time');
  await expect(firstEnd).toHaveValue('00:11.8');
  await page.getByRole('button', { name: 'Nudge first boundary later' }).click();
  await expect(firstEnd).toHaveValue('00:12.4');

  await page.getByRole('button', { name: 'Accept 5 shots' }).click();
  await expect(page.getByText('Shot Ledger')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select Shot 01' })).toBeVisible();
  await expect(page.getByText('5 shots · 00:42')).toBeVisible();

  await page.getByRole('button', { name: 'Select Shot 02' }).click();
  await expect(page.getByTestId('agent-target-chip')).toHaveText('Shot 02');
});

test('editorial core can reject and regenerate without partially applying shots', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Propose shots' }).click();
  await page.getByRole('button', { name: 'Ask attached agent' }).click();

  await expect(page.getByText('Staged proposal · project unchanged')).toBeVisible();
  await page.getByRole('button', { name: 'Reject proposal' }).click();
  await expect(page.getByText('Untouched transcript')).toBeVisible();
  await expect(page.getByText('Shot Ledger')).toHaveCount(0);

  await page.getByRole('button', { name: 'Propose shots' }).click();
  await page.getByRole('radio', { name: 'Punchy' }).check();
  await page.getByRole('button', { name: 'Ask attached agent' }).click();
  await page.getByRole('button', { name: 'Regenerate proposal' }).click();
  await expect(page.getByText('Attempt 2 · Punchy pacing')).toBeVisible();
  await expect(page.getByText('Shot Ledger')).toHaveCount(0);
});
