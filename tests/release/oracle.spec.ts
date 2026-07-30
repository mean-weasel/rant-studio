import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { startLocalService } from '../../apps/service/src/server.ts';
import { openProjectStore } from '../../apps/service/src/store.ts';
import { RantClient } from '../../packages/api/src/index.ts';

function command(program: string, args: string[]): string {
  const result = spawnSync(program, args, { encoding: 'utf8' });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return result.stdout.trim();
}

async function runCli(
  serviceUrl: string,
  credential: string,
  args: string[],
): Promise<Record<string, any>> {
  const result = await new Promise<{ stderr: string; stdout: string }>(
    (resolve, reject) => {
      execFile(
        'npm',
        ['run', '--silent', 'rant', '--', ...args],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            RANT_STUDIO_CREDENTIAL: credential,
            RANT_STUDIO_URL: serviceUrl,
          },
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr || stdout || error.message));
            return;
          }
          resolve({ stderr, stdout });
        },
      );
    },
  );
  expect(result.stderr).not.toContain('MALFORMED_INPUT');
  return JSON.parse(result.stdout.trim()) as Record<string, any>;
}

test('fresh browser and executable CLI complete the V1 oracle with restart and semantic artifacts', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'rant-studio-browser-cli-oracle-'));
  const databasePath = join(root, 'project.sqlite');
  const managedRoot = join(root, 'media');
  const narrationPath = join(root, 'narration.wav');
  const humanImagePath = join(root, 'human.png');
  const agentImagePath = join(root, 'agent.png');
  command('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=520:duration=0.8:sample_rate=48000',
    '-c:a',
    'pcm_s16le',
    narrationPath,
  ]);
  command('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=orange:s=320x240',
    '-frames:v',
    '1',
    humanImagePath,
  ]);
  command('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=teal:s=320x240',
    '-frames:v',
    '1',
    agentImagePath,
  ]);

  let store = openProjectStore(databasePath, { managedRoot });
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
  let service = await startLocalService({ port: 0, store });
  const originalPort = Number(new URL(service.url).port);
  let projectId = '';

  try {
    await page.goto(`/?mode=intake&service=${encodeURIComponent(service.url)}`);
    await page.getByLabel('Project name').fill('Fresh browser CLI oracle');
    await page.getByRole('button', { name: 'Create project' }).click();
    projectId = (await page.locator('.intake-project code').textContent())!;

    await page.getByLabel('Narration file').setInputFiles(narrationPath);
    await page.getByRole('button', { name: 'Upload narration' }).click();
    await page.getByRole('button', { name: 'Transcribe narration' }).click();
    await page
      .getByRole('button', { name: 'Open editorial workspace' })
      .click();
    await page.getByLabel('Word', { exact: true }).selectOption({ index: 0 });
    await page.getByLabel('Replacement').fill('Corrected');
    await page.getByRole('button', { name: 'Save correction' }).click();
    await expect(page.getByText('Corrected Studio')).toBeVisible();

    await page.getByLabel('Starting shots').fill('2');
    await page
      .getByRole('button', { name: 'Queue external shot proposal' })
      .click();
    const proposalActivity = await runCli(service.url, agentCredential.token, [
      'project',
      'activity',
      projectId,
    ]);
    const proposalTask = proposalActivity.tasks.find(
      (task: { kind: string; status: string }) =>
        task.kind === 'proposal' && task.status === 'queued',
    );
    const session = await runCli(service.url, agentCredential.token, [
      'agent',
      'attach',
      projectId,
    ]);
    await runCli(service.url, agentCredential.token, [
      'task',
      'claim',
      projectId,
      proposalTask.id,
      '--session',
      session.id,
    ]);
    const proposalContext = await runCli(service.url, agentCredential.token, [
      'proposal',
      'context',
      projectId,
      proposalTask.id,
    ]);
    const proposalPath = join(root, 'semantic-shot-proposal.json');
    await writeFile(
      proposalPath,
      JSON.stringify({
        shots: [
          {
            endWordOrdinal: 0,
            id: 'a1da8d4e-79ee-49f2-a446-86303227ef5d',
            rationale: 'Keep the corrected opening claim distinct.',
            startWordOrdinal: 0,
            theme: 'Corrected premise',
          },
          {
            endWordOrdinal: 1,
            id: 'fc622c2d-6466-4591-90de-8cdab17cd8c2',
            rationale: 'Let the studio name land as the closing beat.',
            startWordOrdinal: 1,
            theme: 'Studio payoff',
          },
        ],
        summary:
          'Two specific beats preserve the corrected premise and its payoff.',
      }),
    );
    await runCli(service.url, agentCredential.token, [
      'proposal',
      'submit',
      projectId,
      proposalTask.id,
      '--revision',
      String(proposalContext.baseProjectRevision),
      '--transcript',
      String(proposalContext.baseTranscriptRevisionId),
      '--shots-file',
      proposalPath,
    ]);
    await expect(
      page.getByText('Agent result · ready for review'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Accept shots' }).click();

    await page
      .getByRole('button', { name: 'Open production Shot Ledger' })
      .click();
    await page.getByLabel('Checkpoint name').fill('Oracle checkpoint');
    await page.getByRole('button', { name: 'Name checkpoint' }).click();
    await page.getByRole('button', { name: 'Move up' }).nth(1).click();
    await page.getByRole('button', { name: 'Undo last ledger edit' }).click();
    await page.getByRole('button', { name: 'Cut' }).first().click();
    await page
      .getByRole('button', { name: 'Restore Oracle checkpoint' })
      .click();
    await expect(page.locator('.production-ledger-rows > li')).toHaveCount(2);

    await page.getByRole('button', { name: 'Open visual workspace' }).click();
    await page
      .getByLabel('Visual candidate (PNG or MP4)')
      .setInputFiles(humanImagePath);
    await page
      .getByRole('button', { name: 'Upload to selected shots' })
      .click();
    await page.getByRole('button', { name: 'Use this visual' }).first().click();
    await page.getByRole('button', { name: 'Ask agent' }).nth(1).click();
    await page
      .getByRole('button', { name: 'Dispatch task to CLI agent' })
      .click();
    await expect(
      page.getByRole('status').filter({ hasText: /Agent task .* queued/ }),
    ).toBeVisible();

    const assetActivity = await runCli(service.url, agentCredential.token, [
      'project',
      'activity',
      projectId,
    ]);
    const assetTask = assetActivity.tasks.find(
      (task: { kind: string; status: string }) =>
        task.kind === 'asset' && task.status === 'queued',
    );
    await runCli(service.url, agentCredential.token, [
      'task',
      'claim',
      projectId,
      assetTask.id,
      '--session',
      session.id,
    ]);
    const sharedAssets = await runCli(service.url, agentCredential.token, [
      'project',
      'assets',
      projectId,
    ]);
    const withAgentAsset = await runCli(service.url, agentCredential.token, [
      'asset',
      'attach',
      projectId,
      '--revision',
      String(sharedAssets.revision),
      '--shots',
      assetTask.shotIds.join(','),
      '--file',
      agentImagePath,
      '--task',
      assetTask.id,
    ]);
    await runCli(service.url, agentCredential.token, [
      'task',
      'transition',
      projectId,
      assetTask.id,
      '--revision',
      String(withAgentAsset.revision),
      '--status',
      'succeeded',
      '--idempotency',
      'oracle-agent-asset',
      '--summary',
      'External CLI attached the second visual.',
    ]);
    await expect(page.getByText('1 candidate', { exact: true })).toHaveCount(2);
    await page
      .locator('.asset-shot-list > article')
      .nth(1)
      .getByRole('button', { name: 'Use this visual' })
      .click();
    await expect(
      page.getByRole('button', { name: 'Selected', exact: true }),
    ).toHaveCount(2);

    await page.getByRole('button', { name: 'Open preview and export' }).click();
    await page.getByRole('button', { name: 'Play selected shot' }).click();
    await expect(page.locator('.playable-preview video')).toHaveAttribute(
      'src',
      /^blob:/,
    );
    await expect(page.getByText(/Individual shot · revision/)).toBeVisible();
    await page.getByRole('button', { name: 'Play assembled edit' }).click();
    await expect(page.getByText(/Assembled edit · revision/)).toBeVisible();
    await page.getByRole('button', { name: 'Render selected formats' }).click();
    await expect(
      page.getByText(/Render succeeded with 2 artifacts/),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText('External CLI attached the second visual.'),
    ).toBeVisible();
    await page.getByText(/History ·/).click();
    await expect(page.locator('.ledger-history li')).not.toHaveCount(0);

    const human = new RantClient({
      baseUrl: service.url,
      credential: humanCredential.token,
    });
    const media = await human.getMedia(projectId);
    const successful = media.jobs.find((job) => job.status === 'succeeded')!;
    expect(successful.artifacts).toHaveLength(2);
    const evidence = successful.artifacts.map((artifact) => {
      const probe = JSON.parse(
        command('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'format=duration:stream=codec_type,width,height',
          '-of',
          'json',
          artifact.publishedPath,
        ]),
      ) as {
        format: { duration: string };
        streams: Array<{ codec_type: string; height?: number; width?: number }>;
      };
      expect(
        probe.streams.some((stream) => stream.codec_type === 'audio'),
      ).toBe(true);
      const video = probe.streams.find(
        (stream) => stream.codec_type === 'video',
      )!;
      expect([video.width, video.height]).toEqual(
        artifact.format === 'landscape' ? [1920, 1080] : [1080, 1920],
      );
      expect(Number(probe.format.duration)).toBeGreaterThan(0.7);
      return {
        format: artifact.format,
        sha256: artifact.checksum,
      };
    });

    await page.reload();
    await service.close();
    store.close();
    store = openProjectStore(databasePath, { managedRoot });
    service = await startLocalService({ port: originalPort, store });
    await page.getByLabel('Existing project ID').fill(projectId);
    await page.getByRole('button', { name: 'Open existing project' }).click();
    await expect(
      page.getByText('Project reopened. Revision', { exact: false }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Open editorial workspace' })
      .click();
    await expect(page.getByText('2 stable shots')).toBeVisible();
    expect(
      (
        await runCli(service.url, agentCredential.token, [
          'project',
          'media',
          projectId,
        ])
      ).jobs.some(
        (job: { artifacts: unknown[]; status: string }) =>
          job.status === 'succeeded' && job.artifacts.length === 2,
      ),
    ).toBe(true);

    process.stdout.write(
      `# browser-cli-oracle ${JSON.stringify({ evidence, projectId })}\n`,
    );
  } finally {
    await service.close().catch(() => undefined);
    store.close();
  }
});
