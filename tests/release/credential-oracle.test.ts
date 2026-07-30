import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MacOSKeychainSecretStore,
  TranscriptionCredentialRegistry,
} from '../../apps/service/src/credential-store.ts';
import { openProviderMetadataStore } from '../../apps/service/src/provider-metadata.ts';
import { openProjectStore } from '../../apps/service/src/store.ts';
import { MemorySecretStore } from '../helpers/memory-secret-store.ts';

test('provider precedence is environment, persisted Keychain metadata, then deterministic', async () => {
  const databasePath = join(
    tmpdir(),
    `rant-studio-credential-precedence-${randomUUID()}.sqlite`,
  );
  const store = openProjectStore(databasePath);
  const metadata = openProviderMetadataStore(databasePath);
  const secrets = new MemorySecretStore();
  const keychainCanary = `keychain-${randomUUID()}`;
  await new TranscriptionCredentialRegistry({
    metadata,
    secretStore: secrets,
  }).configure({
    credential: keychainCanary,
    provider: 'openai',
  });

  const environmentCanary = `environment-${randomUUID()}`;
  const environmentRegistry = new TranscriptionCredentialRegistry({
    environment: {
      GROQ_API_KEY: environmentCanary,
      RANT_STUDIO_TRANSCRIPTION_PROVIDER: 'groq',
    },
    metadata,
    secretStore: secrets,
  });
  assert.equal(
    (await environmentRegistry.resolveProvider()).name,
    'groq:whisper-large-v3-turbo',
  );
  const environmentSnapshot = await environmentRegistry.snapshot();
  assert.deepEqual(
    {
      activeProvider: environmentSnapshot.activeProvider,
      activeSource: environmentSnapshot.activeSource,
      openaiSource: environmentSnapshot.providers[0]!.source,
      groqSource: environmentSnapshot.providers[1]!.source,
    },
    {
      activeProvider: 'groq',
      activeSource: 'environment',
      groqSource: 'environment',
      openaiSource: 'keychain',
    },
  );
  assert.equal(
    JSON.stringify(environmentSnapshot).includes(environmentCanary),
    false,
  );

  const deterministicRegistry = new TranscriptionCredentialRegistry({
    environment: { RANT_STUDIO_TRANSCRIPTION_PROVIDER: 'deterministic' },
    metadata,
    secretStore: secrets,
  });
  assert.equal(
    (await deterministicRegistry.resolveProvider()).name,
    'deterministic',
  );

  await new TranscriptionCredentialRegistry({
    metadata,
    secretStore: secrets,
  }).remove('openai');
  assert.equal(
    (
      await new TranscriptionCredentialRegistry({
        metadata,
        secretStore: secrets,
      }).resolveProvider()
    ).name,
    'deterministic',
  );
  const databaseBytes = await readFile(databasePath);
  assert.equal(databaseBytes.includes(Buffer.from(keychainCanary)), false);
  assert.equal(databaseBytes.includes(Buffer.from(environmentCanary)), false);
  metadata.close();
  store.close();
});

test('Keychain command shape keeps secret material out of argv', async () => {
  const source = await readFile(
    join(process.cwd(), 'apps/service/src/credential-store.ts'),
    'utf8',
  );
  assert.match(
    source,
    /spawn\('\/usr\/bin\/expect', \['-c', keychainWriteScript\]/,
  );
  assert.match(source, /child\.stdin\.end\(`\$\{input\.password\}\\n`\)/);
  assert.equal(
    source.includes('RANT_STUDIO_KEYCHAIN_PASSWORD'),
    false,
    'Secret must not be passed through the child environment',
  );
});

test(
  'macOS Keychain persists only in a test-owned namespace across adapter restart',
  { skip: process.platform !== 'darwin' },
  async () => {
    const service = `com.mean-weasel.rant-studio.test.${randomUUID()}`;
    const canary = `macos-keychain-${randomUUID()}`;
    const first = new MacOSKeychainSecretStore(service);
    const restarted = new MacOSKeychainSecretStore(service);
    try {
      await first.set('groq', canary);
      assert.equal(await restarted.get('groq'), canary);
      const processList = spawnSync('ps', ['-axo', 'command'], {
        encoding: 'utf8',
      }).stdout;
      assert.equal(processList.includes(canary), false);
      const rotated = `${canary}-rotated`;
      await restarted.set('groq', rotated);
      assert.equal(await first.get('groq'), rotated);
    } finally {
      await restarted.delete('groq');
    }
    assert.equal(await first.get('groq'), undefined);
  },
);
