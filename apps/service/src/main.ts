import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { openProjectStore } from './store.ts';
import { startLocalService } from './server.ts';

const dataRoot = resolve(
  process.env.RANT_STUDIO_DATA_DIR ?? '.rant-studio',
);
const importRoot = resolve(
  process.env.RANT_STUDIO_IMPORT_ROOT ?? process.cwd(),
);
const port = Number(process.env.RANT_STUDIO_PORT ?? 4174);

await mkdir(dataRoot, { recursive: true });
const store = openProjectStore(resolve(dataRoot, 'rant-studio.sqlite'), {
  importRoot,
  managedRoot: resolve(dataRoot, 'media'),
});
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
const service = await startLocalService({ port, store });

process.stdout.write(
  [
    `Rant Studio service: ${service.url}`,
    `Local human credential: ${humanCredential.token}`,
    `Local agent credential: ${agentCredential.token}`,
    `Managed data: ${dataRoot}`,
    'Open the web app with ?mode=intake and connect using the values above.',
    '',
  ].join('\n'),
);

async function close() {
  await service.close();
  store.close();
}

process.once('SIGINT', () => void close().then(() => process.exit(0)));
process.once('SIGTERM', () => void close().then(() => process.exit(0)));
