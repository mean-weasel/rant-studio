import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import test from 'node:test';

import { RantClient } from '../../packages/api/src/index.ts';
import { TranscriptionCredentialRegistry } from '../../apps/service/src/credential-store.ts';
import { applyMigrations } from '../../apps/service/src/migrations.ts';
import { openProviderMetadataStore } from '../../apps/service/src/provider-metadata.ts';
import { openProjectStore } from '../../apps/service/src/store.ts';
import { startLocalService } from '../../apps/service/src/server.ts';
import { MemorySecretStore } from '../helpers/memory-secret-store.ts';

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
  'transcription_provider_credentials',
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
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  const tableNames = tableRows.map(({ name }) => name);
  for (const table of requiredTables)
    assert.ok(tableNames.includes(table), table);
  assert.deepEqual(
    (
      database
        .prepare('SELECT version FROM migrations ORDER BY version')
        .all() as Array<{
        version: number;
      }>
    ).map(({ version }) => version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  database.close();

  const reopened = openProjectStore(databasePath);
  assert.deepEqual(reopened.getProject(project.id), project);
  reopened.close();
});

test('provider migration preserves OpenAI metadata and drops incompatible xAI metadata', async () => {
  const databasePath = await temporaryDatabase();
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE transcription_provider_credentials (
      provider TEXT PRIMARY KEY CHECK (provider IN ('openai', 'xai')),
      keychain_account TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('configured', 'valid', 'invalid')),
      selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_validated_at TEXT
    );
    CREATE UNIQUE INDEX transcription_provider_one_selected
      ON transcription_provider_credentials (selected)
      WHERE selected = 1;
  `);
  const now = new Date().toISOString();
  const migrationInsert = database.prepare(
    'INSERT INTO migrations (version, applied_at) VALUES (?, ?)',
  );
  for (let version = 1; version <= 10; version += 1) {
    migrationInsert.run(version, now);
  }
  const providerInsert = database.prepare(
    `INSERT INTO transcription_provider_credentials
     (provider, keychain_account, status, selected, created_at, updated_at)
     VALUES (?, ?, 'configured', ?, ?, ?)`,
  );
  providerInsert.run('openai', 'openai', 0, now, now);
  providerInsert.run('xai', 'xai', 1, now, now);

  applyMigrations(database);

  assert.deepEqual(
    database
      .prepare(
        'SELECT provider, keychain_account, selected FROM transcription_provider_credentials',
      )
      .all(),
    [{ keychain_account: 'openai', provider: 'openai', selected: 0 }],
  );
  database
    .prepare(
      `INSERT INTO transcription_provider_credentials
       (provider, keychain_account, status, selected, created_at, updated_at)
       VALUES ('groq', 'groq', 'configured', 1, ?, ?)`,
    )
    .run(now, now);
  assert.throws(() =>
    database
      .prepare(
        `INSERT INTO transcription_provider_credentials
         (provider, keychain_account, status, selected, created_at, updated_at)
         VALUES ('xai', 'xai', 'configured', 0, ?, ?)`,
      )
      .run(now, now),
  );
  assert.ok(
    database.prepare('SELECT 1 FROM migrations WHERE version = 11').get(),
  );
  database.close();
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
      error instanceof Error &&
      'code' in error &&
      error.code === 'REVISION_CONFLICT',
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
      error instanceof Error &&
      'code' in error &&
      error.code === 'SECRET_MATERIAL',
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

test('loopback service gives local owner and agent clients one revision truth with revocable credentials', async () => {
  const databasePath = await temporaryDatabase();
  const store = openProjectStore(databasePath);
  const agentCredential = store.issueCredential({
    role: 'agent',
    scopes: ['project:read', 'note:add'],
  });
  const service = await startLocalService({ port: 0, store });
  assert.match(service.url, /^http:\/\/127\.0\.0\.1:/);

  const browserClient = new RantClient({
    baseUrl: service.url,
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
      error instanceof Error &&
      'code' in error &&
      error.code === 'UNAUTHORIZED',
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

    const localOwner = await fetch(`${service.url}/v1/projects`, {
      body: JSON.stringify({ name: 'Exact-origin owner' }),
      headers: {
        'content-type': 'application/json',
        origin: allowedOrigin,
      },
      method: 'POST',
    });
    assert.equal(localOwner.status, 201);

    const wrongOrigin = await fetch(`${service.url}/v1/projects`, {
      body: JSON.stringify({ name: 'Wrong-origin owner' }),
      headers: {
        'content-type': 'application/json',
        origin: 'http://other.localhost:4173',
      },
      method: 'POST',
    });
    assert.equal(wrongOrigin.status, 401);

    const invalidCredential = await fetch(`${service.url}/v1/projects`, {
      body: JSON.stringify({ name: 'Invalid-token fallback' }),
      headers: {
        authorization: 'Bearer definitely-invalid',
        'content-type': 'application/json',
        origin: allowedOrigin,
      },
      method: 'POST',
    });
    assert.equal(invalidCredential.status, 401);
  } finally {
    await service.close();
    store.close();
  }
});

test('provider credentials are owner-write-only, exact-origin, metadata-only, dynamic, and redacted', async () => {
  const databasePath = await temporaryDatabase();
  const store = openProjectStore(databasePath);
  const metadata = openProviderMetadataStore(databasePath);
  const secrets = new MemorySecretStore();
  const validationRequests: Array<{
    authorization: string | null;
    url: string;
  }> = [];
  const registry = new TranscriptionCredentialRegistry({
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      validationRequests.push({
        authorization: new Headers(init?.headers).get('authorization'),
        url: String(input),
      });
      return new Response('{"data":[]}', {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    }) as typeof fetch,
    metadata,
    secretStore: secrets,
  });
  const agent = store.issueCredential({
    role: 'agent',
    scopes: ['provider:read'],
  });
  const appOrigin = 'http://rant-studio.localhost:4173';
  const service = await startLocalService({
    appOrigin,
    credentialRegistry: registry,
    port: 0,
    store,
  });
  const canary = 'OPENAI-CANARY-never-persist-or-return';
  const groqCanary = 'GROQ-CANARY-never-persist-or-return';

  function request(
    path: string,
    input: {
      body?: unknown;
      credential?: string;
      method?: string;
      origin?: string;
    } = {},
  ) {
    return fetch(`${service.url}${path}`, {
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      headers: {
        ...(input.credential
          ? { authorization: `Bearer ${input.credential}` }
          : {}),
        'content-type': 'application/json',
        ...(input.origin ? { origin: input.origin } : {}),
      },
      method: input.method ?? 'GET',
    });
  }

  try {
    const deniedOrigin = await request(
      '/v1/transcription-providers/openai/credential',
      {
        body: { credential: canary },
        method: 'PUT',
        origin: 'http://other.localhost:4173',
      },
    );
    assert.equal(deniedOrigin.status, 401);
    assert.equal(await secrets.get('openai'), undefined);

    const deniedAgent = await request(
      '/v1/transcription-providers/openai/credential',
      {
        body: { credential: canary },
        credential: agent.token,
        method: 'PUT',
        origin: appOrigin,
      },
    );
    assert.equal(deniedAgent.status, 403);
    assert.equal(await secrets.get('openai'), undefined);

    const configured = await request(
      '/v1/transcription-providers/openai/credential',
      {
        body: { credential: canary },
        method: 'PUT',
        origin: appOrigin,
      },
    );
    assert.equal(configured.status, 200);
    assert.equal(
      configured.headers.get('access-control-allow-origin'),
      appOrigin,
    );
    const configuredJson = JSON.stringify(await configured.json());
    assert.equal(configuredJson.includes(canary), false);
    assert.equal(await secrets.get('openai'), canary);

    const listed = await request('/v1/transcription-providers', {
      credential: agent.token,
    });
    assert.equal(listed.status, 200);
    const listedJson = JSON.stringify(await listed.json());
    assert.equal(listedJson.includes(canary), false);
    assert.match(listedJson, /"activeProvider":"openai"/);
    assert.match(listedJson, /"source":"keychain"/);

    const tested = await request('/v1/transcription-providers/openai/test', {
      method: 'POST',
      origin: appOrigin,
    });
    assert.equal(tested.status, 200);
    assert.deepEqual(validationRequests, [
      {
        authorization: `Bearer ${canary}`,
        url: 'https://api.openai.com/v1/models',
      },
    ]);
    assert.equal(JSON.stringify(await tested.json()).includes(canary), false);
    assert.equal(metadata.selected()?.status, 'valid');

    const rotated = `${canary}-rotated`;
    await request('/v1/transcription-providers/openai/credential', {
      body: { credential: rotated },
      method: 'PUT',
      origin: appOrigin,
    });
    assert.equal(await secrets.get('openai'), rotated);
    assert.equal((await registry.resolveProvider()).name, 'openai:whisper-1');

    const removed = await request(
      '/v1/transcription-providers/openai/credential',
      { method: 'DELETE', origin: appOrigin },
    );
    assert.equal(removed.status, 200);
    assert.equal(await secrets.get('openai'), undefined);
    assert.equal((await registry.resolveProvider()).name, 'deterministic');

    const configuredGroq = await request(
      '/v1/transcription-providers/groq/credential',
      {
        body: { credential: groqCanary },
        method: 'PUT',
        origin: appOrigin,
      },
    );
    assert.equal(configuredGroq.status, 200);
    const testedGroq = await request('/v1/transcription-providers/groq/test', {
      method: 'POST',
      origin: appOrigin,
    });
    assert.equal(testedGroq.status, 200);
    assert.deepEqual(validationRequests.at(-1), {
      authorization: `Bearer ${groqCanary}`,
      url: 'https://api.groq.com/openai/v1/models',
    });
    assert.equal(
      JSON.stringify(await testedGroq.json()).includes(groqCanary),
      false,
    );
    await request('/v1/transcription-providers/groq/credential', {
      method: 'DELETE',
      origin: appOrigin,
    });
  } finally {
    await service.close();
    metadata.close();
    store.close();
  }

  const databaseBytes = await readFile(databasePath);
  assert.equal(databaseBytes.includes(Buffer.from(canary)), false);
  assert.equal(databaseBytes.includes(Buffer.from(groqCanary)), false);
});

test('authenticated service event subscription streams project revisions and reconnects', async () => {
  const databasePath = await temporaryDatabase();
  const store = openProjectStore(databasePath);
  const humanCredential = store.issueCredential({
    role: 'human',
    scopes: ['project:*'],
  });
  const agentCredential = store.issueCredential({
    role: 'agent',
    scopes: ['project:read', 'note:add'],
  });
  const service = await startLocalService({ port: 0, store });
  const human = new RantClient({
    baseUrl: service.url,
    credential: humanCredential.token,
  });
  const agent = new RantClient({
    baseUrl: service.url,
    credential: agentCredential.token,
  });
  try {
    const project = await human.createProject('Live revision');
    const events: Array<{
      operation: string;
      projectId: string;
      revision: number;
    }> = [];
    const stop = human.subscribeEvents((event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await agent.mutateProject(project.id, {
      expectedRevision: project.revision,
      operation: 'add_note',
      payload: { note: 'External CLI event.' },
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('event was not delivered')),
        2_000,
      );
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
  const humanCredential = store.issueCredential({
    role: 'human',
    scopes: ['project:*'],
  });
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
        payload: {
          note: 'The role allows this, but the token scope does not.',
        },
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
