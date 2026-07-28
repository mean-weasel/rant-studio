import { expect, test, type Page } from '@playwright/test';

async function openProposal(page: Page, pacing = 'Standard') {
  await page.goto('/');
  await page.getByRole('button', { name: 'Propose shots' }).click();
  if (pacing !== 'Standard') {
    await page.getByRole('radio', { name: pacing }).check();
  }
  await page.getByRole('button', { name: 'Ask attached agent' }).click();
  await expect(
    page.getByText('Staged proposal · project unchanged'),
  ).toBeVisible();
}

async function openAcceptedLedger(page: Page, pacing = 'Standard') {
  await openProposal(page, pacing);
  await page.getByRole('button', { name: 'Accept 5 shots' }).click();
  await expect(
    page.getByRole('heading', { name: 'Shot Ledger' }),
  ).toBeVisible();
}

test('long corrected transcript stays bounded and survives proposal acceptance', async ({
  page,
}) => {
  const longTranscript = Array.from(
    { length: 18 },
    (_, index) =>
      `This is a deliberately long transcript fragment number ${index + 1}.`,
  ).join(' ');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Correct transcript' }).click();
  await page.getByLabel('Corrected transcript text').fill(longTranscript);
  await page.getByRole('button', { name: 'Save correction' }).click();
  await page.getByRole('button', { name: 'Propose shots' }).click();
  await page.getByRole('button', { name: 'Ask attached agent' }).click();

  const proposalChunk = page.getByTestId('proposal-transcript-01');
  await expect(proposalChunk).toContainText(longTranscript);
  expect(
    await proposalChunk.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth ===
        document.documentElement.clientWidth,
    ),
  ).toBe(true);

  await page.getByRole('button', { name: 'Accept 5 shots' }).click();
  const ledgerChunk = page.getByTestId('shot-transcript-01');
  await expect(ledgerChunk).toHaveText(longTranscript);
  expect(
    await ledgerChunk.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
});

test('accepted ledger preserves pacing and the shared adjusted boundary', async ({
  page,
}) => {
  await openProposal(page, 'Punchy');
  await page
    .getByRole('button', { name: 'Nudge first boundary later' })
    .click();

  await expect(page.getByLabel('Shot 1 end time')).toHaveValue('00:12.4');
  await expect(page.getByLabel('Shot 2 start time')).toHaveValue('00:12.4');
  await page.getByRole('button', { name: 'Accept 5 shots' }).click();

  await expect(page.getByText('Punchy pacing')).toBeVisible();
  await expect(page.getByTestId('shot-01')).toContainText('00:00.0–00:12.4');
  await expect(page.getByTestId('shot-02')).toContainText('00:12.4–00:20.2');
});

test('accepting a proposal lands focus at the start of the new ledger workspace', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProposal(page);
  await page.getByRole('button', { name: 'Accept 5 shots' }).click();

  const ledgerHeading = page.getByRole('heading', { name: 'Shot Ledger' });
  await expect(ledgerHeading).toBeFocused();
  const headingBox = await ledgerHeading.boundingBox();
  expect(headingBox?.y).toBeGreaterThanOrEqual(160);
  expect(headingBox?.y).toBeLessThan(844);
});

test('mobile project navigation keeps views and primary project actions reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const mobileNav = page.getByRole('navigation', {
    name: 'Mobile project controls',
  });
  await expect(mobileNav).toBeVisible();
  await mobileNav.getByRole('button', { name: 'Activity' }).click();
  await expect(
    page.getByRole('heading', { name: 'Agent activity' }),
  ).toBeVisible();
  await expect(
    mobileNav.getByRole('button', { name: 'Reset demo' }),
  ).toBeVisible();
  await expect(mobileNav.getByText('Codex attached')).toBeVisible();
});

test('mobile agent dock starts compact and expands without losing its shot target', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAcceptedLedger(page);

  await expect(page.getByTestId('agent-target-chip')).toHaveText('Shot 01');
  await expect(page.getByLabel('Instruction for attached agent')).toBeHidden();
  await page.getByRole('button', { name: 'Expand agent dock' }).click();
  await expect(page.getByLabel('Instruction for attached agent')).toBeVisible();
  await expect(page.getByTestId('agent-target-chip')).toHaveText('Shot 01');
});

test('dialogs are named, trap keyboard focus, close on Escape, and restore focus', async ({
  page,
}) => {
  await openAcceptedLedger(page);

  const opener = page.getByRole('button', { name: 'Open preview' });
  await opener.focus();
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Assembled preview' });
  await expect(dialog).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Close preview' }),
  ).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(
    page.getByRole('button', { name: 'Contain landscape visual' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test('reset cancels an in-flight agent task without resurrecting state', async ({
  page,
}) => {
  await openAcceptedLedger(page);
  await page.getByRole('button', { name: 'Select Shot 03' }).click();
  await page
    .getByLabel('Instruction for attached agent')
    .fill('Find a quieter metaphor.');
  await page.getByRole('button', { name: 'Send instruction' }).click();
  await page.getByRole('button', { name: 'Reset demo' }).click();
  await page.waitForTimeout(700);

  await page.getByRole('button', { name: 'Activity' }).click();
  await expect(page.getByText('No agent work yet')).toBeVisible();
  await expect(page.getByText('Find a quieter metaphor.')).toHaveCount(0);
});

test('export authority copy derives every missing-shot reference from live state', async ({
  page,
}) => {
  await openAcceptedLedger(page);
  await page.getByRole('button', { name: 'Export' }).click();

  await expect(page.getByText('4 shots need visuals')).toBeVisible();
  await expect(
    page.getByText('Shots 02, 03, 04, and 05 will use'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Export anyway' }).click();
  await expect(
    page.getByText('I understand that four shots are visually incomplete.'),
  ).toBeVisible();
});

test('row quick action targets the shot and prefills an agent instruction', async ({
  page,
}) => {
  await openAcceptedLedger(page);
  await page
    .getByTestId('shot-03')
    .getByRole('button', { name: 'Ask agent for candidates for Shot 03' })
    .click();

  await expect(page.getByTestId('agent-target-chip')).toHaveText('Shot 03');
  await expect(page.getByLabel('Instruction for attached agent')).toHaveValue(
    'Find visual candidates for Shot 03 without selecting one.',
  );
});

test('candidate count always matches the reachable assets in its bounded tray', async ({
  page,
}) => {
  await openAcceptedLedger(page);
  await page.getByRole('button', { name: 'Select Shot 03' }).click();
  const sendButton = page.getByRole('button', { name: 'Send instruction' });

  for (const instruction of [
    'Find option one.',
    'Find option two.',
    'Find option three.',
  ]) {
    await page.getByLabel('Instruction for attached agent').fill(instruction);
    await sendButton.click();
    await expect(sendButton).toBeDisabled();
    await expect(page.getByRole('status')).toContainText(
      'Codex added a candidate to Shot 03',
    );
  }

  const shot = page.getByTestId('shot-03');
  await expect(shot.getByText('3 candidates · none selected')).toBeVisible();
  await expect(shot.locator('[data-candidate-asset]')).toHaveCount(3);
});
