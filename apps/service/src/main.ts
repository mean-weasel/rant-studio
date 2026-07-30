import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

import {
  MacOSKeychainSecretStore,
  TranscriptionCredentialRegistry,
} from './credential-store.ts';
import { openProviderMetadataStore } from './provider-metadata.ts';
import { openProjectStore } from './store.ts';
import { startLocalService } from './server.ts';

try {
  loadEnvFile('.env.local');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const dataRoot = resolve(process.env.RANT_STUDIO_DATA_DIR ?? '.rant-studio');
const importRoot = resolve(
  process.env.RANT_STUDIO_IMPORT_ROOT ?? process.cwd(),
);
const port = Number(process.env.RANT_STUDIO_PORT ?? 4174);

await mkdir(dataRoot, { recursive: true });
const databasePath = resolve(dataRoot, 'rant-studio.sqlite');
const store = openProjectStore(databasePath, {
  importRoot,
  managedRoot: resolve(dataRoot, 'media'),
});
const metadata = openProviderMetadataStore(databasePath);
const credentialRegistry = new TranscriptionCredentialRegistry({
  environment: process.env,
  metadata,
  secretStore: new MacOSKeychainSecretStore(),
});
const agentCredential = store.issueCredential({
  role: 'agent',
  scopes: [
    'project:read',
    'task:claim',
    'proposal:write',
    'asset:add',
    'asset:recommend',
    'provider:read',
  ],
});
const service = await startLocalService({ credentialRegistry, port, store });
const providerSnapshot = await credentialRegistry.snapshot();

process.stdout.write(
  [
    `Rant Studio service: ${service.url}`,
    `Transcription provider: ${providerSnapshot.activeProvider}`,
    `Local agent credential: ${agentCredential.token}`,
    `Managed data: ${dataRoot}`,
    'Open the web app with ?mode=intake; the local owner connects automatically.',
    '',
  ].join('\n'),
);

async function close() {
  await service.close();
  metadata.close();
  store.close();
}

process.once('SIGINT', () => void close().then(() => process.exit(0)));
process.once('SIGTERM', () => void close().then(() => process.exit(0)));
