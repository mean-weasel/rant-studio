import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { openProjectStore } from '../apps/service/src/store.ts';
import { startLocalService } from '../apps/service/src/server.ts';
import { RantClient } from '../packages/api/src/index.ts';

test('browser and CLI agent share discover and outline planning context', async ({
  page,
}) => {
  const directory = await mkdtemp(
    join(tmpdir(), 'rant-studio-semantic-planning-'),
  );
  const databasePath = join(directory, 'project.db');
  const store = openProjectStore(databasePath);
  const agentCredential = store.issueCredential({
    role: 'agent',
    scopes: ['project:read', 'task:claim', 'proposal:write'],
  });
  const service = await startLocalService({ port: 0, store });
  let closed = false;

  try {
    await page.goto(`/?mode=intake&service=${encodeURIComponent(service.url)}`);
    await page.getByLabel('Project name').fill('Semantic planning QA');
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByLabel('Narration file').setInputFiles({
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
    const words = Array.from({ length: 180 }, (_, index) => ({
      endMs: (index + 1) * 100,
      startMs: index * 100,
      text: index < 90 ? `premise-${index + 1}` : `counterpoint-${index - 89}`,
    }));
    await page.getByText('Import timestamp JSON').click();
    await page.getByLabel('Timestamp JSON').fill(JSON.stringify({ words }));
    await page.getByRole('button', { name: 'Import transcript' }).click();
    await page
      .getByRole('button', { name: 'Open editorial workspace' })
      .click();

    await expect(
      page.getByRole('radio', { name: /Discover structure/ }),
    ).toBeChecked();
    await expect(page.getByLabel('Starting shots')).toHaveValue('3');
    await page.getByLabel('Starting shots').fill('0');
    await expect(
      page.getByText('Starting shots must be between 1 and 180.'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Queue external shot proposal' }),
    ).toBeDisabled();
    await page.getByLabel('Starting shots').fill('3');
    await page
      .getByLabel('Optional agent direction')
      .fill('Prefer complete rhetorical thoughts over equal timing.');
    await page.getByText('Advanced constraints').click();
    await page.getByLabel('Maximum words per shot').fill('100');

    const projectId = (await page
      .locator('.intake-project code')
      .textContent())!;
    const agent = new RantClient({
      baseUrl: service.url,
      credential: agentCredential.token,
    });
    const session = await agent.attachAgent(projectId);
    await page
      .getByRole('button', { name: 'Queue external shot proposal' })
      .click();
    const discoverTask = (
      await agent.getActivity(projectId, {
        status: 'queued',
      })
    ).tasks.find((task) => task.kind === 'proposal')!;
    expect(discoverTask.planning?.mode).toBe('discover');
    expect(discoverTask.planning?.targetShotCount).toBe(3);
    expect(discoverTask.planning?.maxWordsPerShot).toBe(100);
    await agent.claimTask(projectId, discoverTask.id, {
      sessionId: session.id,
    });
    const editorial = await agent.getEditorial(projectId);
    const discoverIds = [
      '1151e921-856a-4df5-9606-3d906c11943d',
      '991d6633-e3ee-4aa1-9503-40e64c0b482d',
    ];
    await agent.submitShotProposal(projectId, discoverTask.id, {
      baseProjectRevision: discoverTask.baseRevision,
      baseTranscriptRevisionId: editorial.effectiveTranscript.id,
      shotCountRationale:
        'The transcript contains two complete rhetorical movements, so two is clearer than forcing the soft target of three.',
      shots: [
        {
          endWordOrdinal: 89,
          id: discoverIds[0],
          rationale: 'Keep the full premise intact before the turn.',
          startWordOrdinal: 0,
          theme: 'The escalating premise',
        },
        {
          endWordOrdinal: 179,
          id: discoverIds[1],
          rationale: 'Let the counterpoint answer the premise as one movement.',
          startWordOrdinal: 90,
          theme: 'The counterpoint',
        },
      ],
      summary: 'Two semantic movements: premise and counterpoint.',
    });

    await expect(
      page.getByText('Agent result · ready for review'),
    ).toBeVisible();
    await expect(
      page.getByText('The escalating premise', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/two complete rhetorical movements/),
    ).toBeVisible();
    const discoverChunk = page.locator('.proposal-chunk').filter({
      hasText: 'premise-1',
    });
    await expect(discoverChunk).toBeVisible();
    expect(
      await discoverChunk.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    ).toBe(true);
    await page.getByRole('button', { name: 'Reject proposal' }).click();

    await page.getByRole('radio', { name: /Map to outline/ }).check();
    await page
      .getByLabel('Outline direction')
      .fill('Use the creator’s premise and counterpoint structure.');
    await page
      .getByLabel('Ordered shot briefs (optional, one per line)')
      .fill(
        'The premise | Establish the escalating premise\nThe turn | Land the counterpoint',
      );
    await expect(page.getByLabel('Starting shots')).toHaveValue('2');
    await expect(page.getByLabel('Starting shots')).toBeDisabled();
    await page
      .getByRole('button', { name: 'Queue regenerated external proposal' })
      .click();
    const outlineTask = (
      await agent.getActivity(projectId, {
        status: 'queued',
      })
    ).tasks.find((task) => task.kind === 'proposal')!;
    expect(outlineTask.planning?.mode).toBe('outline');
    expect(outlineTask.planning?.briefs).toHaveLength(2);
    await agent.claimTask(projectId, outlineTask.id, {
      sessionId: session.id,
    });
    const outlineIds = [
      '0299f61f-bcee-4e03-8362-fb4f156143fd',
      'ec8ef4d1-5c27-4c17-a726-e2da6767248e',
    ];
    await agent.submitShotProposal(projectId, outlineTask.id, {
      baseProjectRevision: outlineTask.baseRevision,
      baseTranscriptRevisionId: editorial.effectiveTranscript.id,
      shots: [
        {
          briefId: 'brief-1',
          endWordOrdinal: 89,
          id: outlineIds[0],
          rationale: 'Maps the supplied premise brief to its complete thought.',
          startWordOrdinal: 0,
          theme: 'The premise',
          visualBrief: 'A stack growing one layer at a time.',
        },
        {
          briefId: 'brief-2',
          endWordOrdinal: 179,
          id: outlineIds[1],
          rationale: 'Maps the supplied turn brief to the answering thought.',
          startWordOrdinal: 90,
          theme: 'The turn',
        },
      ],
      summary: 'Mapped both creator briefs in their supplied order.',
    });
    await expect(page.getByText('Mapped to creator outline')).toBeVisible();
    await expect(
      page.getByText('A stack growing one layer at a time.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Accept shots' }).click();
    const accepted = await agent.getEditorial(projectId);
    expect(accepted.shots.map((shot) => shot.id)).toEqual(outlineIds);
    expect(accepted.rawTranscript.words.map((word) => word.text)).toEqual(
      words.map((word) => word.text),
    );

    await service.close();
    store.close();
    closed = true;
    const reopened = openProjectStore(databasePath);
    try {
      expect(
        reopened.getEditorialProject(projectId).shots.map((shot) => shot.id),
      ).toEqual(outlineIds);
    } finally {
      reopened.close();
    }
  } finally {
    if (!closed) {
      await service.close();
      store.close();
    }
  }
});
