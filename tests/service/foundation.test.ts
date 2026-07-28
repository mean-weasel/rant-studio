import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import test from 'node:test';

import { RantClient } from '../../packages/api/src/index.ts';
import { openProjectStore } from '../../apps/service/src/store.ts';
import { startLocalService } from '../../apps/service/src/server.ts';

const requiredTables = [
  'agent_claims',
  'agent_sessions',
  'agent_tasks',
  'asset_files',
  'asset_provenance',
  'assets',
  'change_events',
  'checkpoints',
  'credentials',
  'edit_sequences',
  'editorial_proposals',
  'format_overrides',
  'job_attempts',
  'jobs',
  'migrations',
  'project_revisions',
  'projects',
  'proposal_operations',
  'render_artifacts',
  'shot_ancestry',
  'shot_candidates',
  'shot_candidate_recommendations',
  'shot_selections',
  'shot_source_spans',
  'shots',
  'shot_versions',
  'source_audio',
  'task_receipts',
  'transcript_corrections',
  'transcript_revisions',
  'transcript_words',
  'transcription_attempts',
] as const;

async function temporaryDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'rant-studio-foundation-'));
  return join(directory, 'project.db');
}

test('fresh migration creates the complete schema once and persists a project revision', async () => {
  const databasePath = await temporaryDatabase();
  const store = openProjectStore(databasePath);
  const project = store.createProject({
    actor: { id: 'human-browser', kind: 'human' },
    name: 'Subscription Fatigue',
  });
  assert.equal(project.revision, 1);
  store.close();

  const database = new Database(databasePath);
  const tableRows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  const tableNames = tableRows.map(({ name }) => name);
  for (const table of requiredTables) assert.ok(tableNames.includes(table), table);
  assert.deepEqual(
    (
      database.prepare('SELECT version FROM migrations ORDER BY version').all() as Array<{
        version: number;
      }>
    ).map(({ version }) => version),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  database.close();

  const reopened = openProjectStore(databasePath);
  assert.deepEqual(reopened.getProject(project.id), project);
  reopened.close();
});

test('mutations are transactional, revision checked, authority checked, secret safe, and observable', async () => {
  const databasePath = await temporaryDatabase();
  const store = openProjectStore(databasePath);
  const project = store.createProject({
    actor: { id: 'human-browser', kind: 'human' },
    name: 'Subscription Fatigue',
  });
  const events: Array<{ operation: string; revision: number }> = [];
  const unsubscribe = store.subscribe((event) => events.push(event));

  assert.throws(
    () =>
      store.applyMutation({
        actor: { id: 'agent-codex', kind: 'agent' },
        expectedRevision: 1,
        operation: 'select_visual',
        payload: { assetId: 'asset-1' },
        projectId: project.id,
      }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'FORBIDDEN',
  );
  assert.equal(store.getProject(project.id).revision, 1);

  assert.throws(
    () =>
      store.applyMutation({
        actor: { id: 'human-browser', kind: 'human' },
        expectedRevision: 0,
        operation: 'select_visual',
        payload: { assetId: 'asset-1' },
        projectId: project.id,
      }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'REVISION_CONFLICT',
  );
  assert.equal(store.getProject(project.id).revision, 1);

  assert.throws(
    () =>
      store.applyMutation({
        actor: { id: 'agent-codex', kind: 'agent' },
        expectedRevision: 1,
        operation: 'add_note',
        payload: { providerApiKey: 'must-not-persist' },
        projectId: project.id,
      }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'SECRET_MATERIAL',
  );

  const result = store.applyMutation({
    actor: { id: 'human-browser', kind: 'human' },
    expectedRevision: 1,
    operation: 'select_visual',
    payload: { assetId: 'asset-1' },
    projectId: project.id,
  });
  assert.equal(result.revision, 2);
  assert.deepEqual(events, [
    { operation: 'select_visual', projectId: project.id, revision: 2 },
  ]);
  unsubscribe();
  store.close();

  const bytes = await readFile(databasePath);
  assert.equal(bytes.includes(Buffer.from('must-not-persist')), false);
});

test('loopback service gives browser and CLI clients one revision truth with revocable credentials', async () => {
  const databasePath = await temporaryDatabase();
  const store = openProjectStore(databasePath);
  const humanCredential = store.issueCredential({ role: 'human', scopes: ['project:*'] });
  const agentCredential = store.issueCredential({ role: 'agent', scopes: ['project:read', 'note:add'] });
  const service = await startLocalService({ port: 0, store });
  assert.match(service.url, /^http:\/\/127\.0\.0\.1:/);

  const browserClient = new RantClient({
    baseUrl: service.url,
    credential: humanCredential.token,
  });
  const cliClient = new RantClient({
    baseUrl: service.url,
    credential: agentCredential.token,
  });
  const created = await browserClient.createProject('Shared Revision');
  assert.equal((await cliClient.getProject(created.id)).revision, 1);

  const agentMutation = await cliClient.mutateProject(created.id, {
    expectedRevision: 1,
    operation: 'add_note',
    payload: { note: 'Try a quieter visual metaphor.' },
  });
  assert.equal(agentMutation.revision, 2);
  assert.equal((await browserClient.getProject(created.id)).revision, 2);

  await assert.rejects(
    cliClient.mutateProject(created.id, {
      expectedRevision: 2,
      operation: 'accept_proposal',
      payload: {},
    }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'FORBIDDEN',
  );
  store.revokeCredential(agentCredential.token);
  await assert.rejects(
    cliClient.getProject(created.id),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'UNAUTHORIZED',
  );

  await service.close();
  store.close();
});

test('loopback CORS accepts localhost subdomains and rejects lookalike hosts', async () => {
  const databasePath = await temporaryDatabase();
  const store = openProjectStore(databasePath);
  const service = await startLocalService({ port: 0, store });
  try {
    const allowedOrigin = 'http://rant-studio.localhost:4173';
    const allowed = await fetch(`${service.url}/v1/health`, {
      headers: { origin: allowedOrigin },
    });
    assert.equal(allowed.status, 200);
    assert.equal(
      allowed.headers.get('access-control-allow-origin'),
      allowedOrigin,
    );

    const denied = await fetch(`${service.url}/v1/health`, {
      headers: { origin: 'http://rant-studio.localhost.example.com:4173' },
    });
    assert.equal(denied.status, 200);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  } finally {
    await service.close();
    store.close();
  }
});

test('authenticated service event subscription streams project revisions and reconnects', async () => {
  const databasePath = await temporaryDatabase();
  const store = openProjectStore(databasePath);
  const humanCredential = store.issueCredential({ role: 'human', scopes: ['project:*'] });
  const agentCredential = store.issueCredential({
    role: 'agent',
    scopes: ['project:read', 'note:add'],
  });
  const service = await startLocalService({ port: 0, store });
  const human = new RantClient({ baseUrl: service.url, credential: humanCredential.token });
  const agent = new RantClient({ baseUrl: service.url, credential: agentCredential.token });
  try {
    const project = await human.createProject('Live revision');
    const events: Array<{ operation: string; projectId: string; revision: number }> = [];
    const stop = human.subscribeEvents((event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await agent.mutateProject(project.id, {
      expectedRevision: project.revision,
      operation: 'add_note',
      payload: { note: 'External CLI event.' },
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('event was not delivered')), 2_000);
      const poll = setInterval(() => {
        if (events.length === 0) return;
        clearInterval(poll);
        clearTimeout(timeout);
        resolve();
      }, 10);
    });
    stop();
    assert.deepEqual(events, [
      { operation: 'add_note', projectId: project.id, revision: 2 },
    ]);
  } finally {
    await service.close();
    store.close();
  }
});

test('loopback credentials enforce scopes in addition to role authority', async () => {
  const databasePath = await temporaryDatabase();
  const store = openProjectStore(databasePath);
  const humanCredential = store.issueCredential({ role: 'human', scopes: ['project:*'] });
  const readOnlyCredential = store.issueCredential({
    role: 'agent',
    scopes: ['project:read'],
  });
  const service = await startLocalService({ port: 0, store });

  const humanClient = new RantClient({
    baseUrl: service.url,
    credential: humanCredential.token,
  });
  const readOnlyClient = new RantClient({
    baseUrl: service.url,
    credential: readOnlyCredential.token,
  });

  try {
    const project = await humanClient.createProject('Scoped project');
    await assert.rejects(
      readOnlyClient.mutateProject(project.id, {
        expectedRevision: project.revision,
        operation: 'add_note',
        payload: { note: 'The role allows this, but the token scope does not.' },
      }),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'FORBIDDEN',
    );
    assert.equal((await humanClient.getProject(project.id)).revision, 1);
  } finally {
    await service.close();
    store.close();
  }
});
