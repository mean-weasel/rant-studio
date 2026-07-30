import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  type SecretStore,
  TranscriptionCredentialRegistry,
} from '../../apps/service/src/credential-store.ts';
import { openProviderMetadataStore } from '../../apps/service/src/provider-metadata.ts';
import { openProjectStore } from '../../apps/service/src/store.ts';
import {
  GroqTranscriptProvider,
  OpenAITranscriptProvider,
  transcriptProviderFromConfiguration,
  transcriptProviderFromEnvironment,
} from '../../packages/transcription/src/index.ts';
import type {
  TranscriptProviderInput,
  TranscriptionProviderName,
} from '../../packages/transcription/src/index.ts';

type CapturedRequest = {
  fields: Array<[string, FormDataEntryValue]>;
  headers: Headers;
  url: string;
};

class ControlledSecretStore implements SecretStore {
  readonly events: string[] = [];
  failDelete = false;
  pauseWrites = false;
  readonly values = new Map<TranscriptionProviderName, string>();

  async delete(provider: TranscriptionProviderName): Promise<void> {
    this.events.push(`delete:${provider}:start`);
    if (this.failDelete) throw new Error('simulated rollback failure');
    if (this.pauseWrites)
      await new Promise((resolve) => setTimeout(resolve, 5));
    this.values.delete(provider);
    this.events.push(`delete:${provider}:end`);
  }

  async get(provider: TranscriptionProviderName): Promise<string | undefined> {
    return this.values.get(provider);
  }

  async set(
    provider: TranscriptionProviderName,
    secret: string,
  ): Promise<void> {
    this.events.push(`set:${secret}:start`);
    if (this.pauseWrites)
      await new Promise((resolve) => setTimeout(resolve, 5));
    this.values.set(provider, secret);
    this.events.push(`set:${secret}:end`);
  }
}

async function sourceInput(): Promise<TranscriptProviderInput> {
  const directory = await mkdtemp(join(tmpdir(), 'rant-provider-'));
  const originalPath = join(directory, 'narration.mp3');
  const managedPath = join(directory, 'narration.wav');
  await writeFile(originalPath, Buffer.from('fixture mp3'));
  await writeFile(managedPath, Buffer.from('fixture wav'));
  return {
    checksum: 'normalized-checksum',
    managedPath,
    mimeType: 'audio/wav',
    originalMimeType: 'audio/mpeg',
    originalName: 'commentary.mp3',
    originalPath,
  };
}

function mockFetch(
  payload: unknown,
  captured: CapturedRequest[],
  status = 200,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    assert.ok(init?.body instanceof FormData);
    captured.push({
      fields: Array.from(init.body.entries()),
      headers: new Headers(init.headers),
      url: String(input),
    });
    return new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json' },
      status,
      statusText: status === 200 ? 'OK' : 'Unauthorized',
    });
  }) as typeof fetch;
}

function fieldValue(
  request: CapturedRequest,
  name: string,
): FormDataEntryValue | undefined {
  return request.fields.find(([field]) => field === name)?.[1];
}

test('OpenAI provider uploads the compressed source and parses word timestamps', async () => {
  const captured: CapturedRequest[] = [];
  const provider = new OpenAITranscriptProvider({
    apiKey: 'openai-test-key',
    fetch: mockFetch(
      {
        duration: 1.24,
        language: 'english',
        text: 'Hello studio',
        words: [
          { end: 0.51, start: 0.004, word: ' Hello' },
          { end: 1.24, start: 0.51, word: 'studio' },
        ],
      },
      captured,
    ),
    language: 'en',
  });

  const result = await provider.transcribe(await sourceInput());

  assert.deepEqual(result.words, [
    { endMs: 510, startMs: 4, text: 'Hello' },
    { endMs: 1240, startMs: 510, text: 'studio' },
  ]);
  assert.equal(captured.length, 1);
  const request = captured[0]!;
  assert.equal(request.url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(request.headers.get('authorization'), 'Bearer openai-test-key');
  assert.equal(fieldValue(request, 'model'), 'whisper-1');
  assert.equal(fieldValue(request, 'response_format'), 'verbose_json');
  assert.equal(fieldValue(request, 'timestamp_granularities[]'), 'word');
  assert.equal(fieldValue(request, 'language'), 'en');
  const file = fieldValue(request, 'file');
  assert.ok(file instanceof Blob);
  assert.equal(file.type, 'audio/mpeg');
  assert.equal((file as File).name, 'commentary.mp3');
  assert.deepEqual(
    request.fields.map(([name]) => name),
    [
      'model',
      'response_format',
      'timestamp_granularities[]',
      'language',
      'file',
    ],
  );
});

test('Groq provider sends word timestamp options before the file and parses its response', async () => {
  const captured: CapturedRequest[] = [];
  const provider = new GroqTranscriptProvider({
    apiKey: 'groq-test-key',
    fetch: mockFetch(
      {
        duration: 2.5,
        language: 'English',
        text: 'Rant Studio',
        words: [
          { end: 1.05, start: 0.2, word: 'Rant' },
          { end: 2.5, start: 1, word: 'Studio' },
        ],
      },
      captured,
    ),
    language: 'en',
  });

  const result = await provider.transcribe(await sourceInput());

  assert.equal(provider.name, 'groq:whisper-large-v3-turbo');
  assert.deepEqual(result.words, [
    { endMs: 1050, startMs: 200, text: 'Rant' },
    { endMs: 2500, startMs: 1050, text: 'Studio' },
  ]);
  const request = captured[0]!;
  assert.equal(
    request.url,
    'https://api.groq.com/openai/v1/audio/transcriptions',
  );
  assert.equal(request.headers.get('authorization'), 'Bearer groq-test-key');
  assert.equal(fieldValue(request, 'model'), 'whisper-large-v3-turbo');
  assert.equal(fieldValue(request, 'response_format'), 'verbose_json');
  assert.equal(fieldValue(request, 'timestamp_granularities[]'), 'word');
  assert.equal(fieldValue(request, 'language'), 'en');
  assert.deepEqual(
    request.fields.map(([name]) => name),
    [
      'model',
      'response_format',
      'timestamp_granularities[]',
      'language',
      'file',
    ],
  );
});

test('remote providers surface bounded API and response failures', async () => {
  const echoedSecret = 'test-key';
  const rejected = new OpenAITranscriptProvider({
    apiKey: echoedSecret,
    fetch: mockFetch(
      { error: { message: `Invalid API key ${echoedSecret}` } },
      [],
      401,
    ),
  });
  await assert.rejects(
    rejected.transcribe(await sourceInput()),
    (error: unknown) =>
      error instanceof Error &&
      /Invalid API key \[REDACTED\]/.test(error.message) &&
      !error.message.includes(echoedSecret),
  );

  const empty = new GroqTranscriptProvider({
    apiKey: 'test-key',
    fetch: mockFetch({ text: '', words: [] }, []),
  });
  await assert.rejects(
    empty.transcribe(await sourceInput()),
    /groq:whisper-large-v3-turbo returned no word timestamps/,
  );

  const regressed = new GroqTranscriptProvider({
    apiKey: 'test-key',
    fetch: mockFetch(
      {
        words: [
          { end: 4, start: 3, word: 'first' },
          { end: 1, start: 0, word: 'second' },
        ],
      },
      [],
    ),
  });
  await assert.rejects(
    regressed.transcribe(await sourceInput()),
    /groq:whisper-large-v3-turbo returned non-chronological word timing at index 1/,
  );
});

test('environment configuration selects providers without exposing credentials', () => {
  assert.equal(transcriptProviderFromEnvironment({}).name, 'deterministic');
  assert.equal(
    transcriptProviderFromEnvironment({
      OPENAI_API_KEY: 'secret',
      RANT_STUDIO_TRANSCRIPTION_PROVIDER: 'openai',
    }).name,
    'openai:whisper-1',
  );
  assert.equal(
    transcriptProviderFromEnvironment({
      GROQ_API_KEY: 'secret',
      RANT_STUDIO_TRANSCRIPTION_PROVIDER: 'groq',
    }).name,
    'groq:whisper-large-v3-turbo',
  );
  assert.throws(
    () =>
      transcriptProviderFromEnvironment({
        RANT_STUDIO_TRANSCRIPTION_PROVIDER: 'openai',
      }),
    /OPENAI_API_KEY is required/,
  );
  assert.throws(
    () =>
      transcriptProviderFromEnvironment({
        RANT_STUDIO_TRANSCRIPTION_PROVIDER: 'unknown',
      }),
    /must be deterministic, openai, or groq/,
  );
});

test('explicit configuration constructs the selected remote provider', () => {
  assert.equal(
    transcriptProviderFromConfiguration({
      apiKey: 'not-observable',
      provider: 'openai',
    }).name,
    'openai:whisper-1',
  );
  assert.equal(
    transcriptProviderFromConfiguration({
      apiKey: 'not-observable',
      provider: 'groq',
    }).name,
    'groq:whisper-large-v3-turbo',
  );
});

test('credential registry serializes mutations, reports rollback failure, and rejects invalid environment selection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rant-registry-'));
  const databasePath = join(directory, 'registry.sqlite');
  const store = openProjectStore(databasePath);
  const metadata = openProviderMetadataStore(databasePath);
  const secrets = new ControlledSecretStore();
  secrets.pauseWrites = true;
  const registry = new TranscriptionCredentialRegistry({
    metadata,
    secretStore: secrets,
  });

  await Promise.all([
    registry.configure({ credential: 'first', provider: 'openai' }),
    registry.configure({ credential: 'second', provider: 'openai' }),
  ]);
  assert.deepEqual(
    secrets.events.filter((event) => event.startsWith('set:')),
    ['set:first:start', 'set:first:end', 'set:second:start', 'set:second:end'],
  );
  assert.equal(await secrets.get('openai'), 'second');

  const invalidEnvironment = new TranscriptionCredentialRegistry({
    environment: { RANT_STUDIO_TRANSCRIPTION_PROVIDER: 'typo' },
    metadata,
    secretStore: secrets,
  });
  await assert.rejects(
    invalidEnvironment.resolveProvider(),
    /must be deterministic, openai, or groq/,
  );
  metadata.close();
  store.close();

  const closedDatabasePath = join(directory, 'closed.sqlite');
  const closedStore = openProjectStore(closedDatabasePath);
  const closedMetadata = openProviderMetadataStore(closedDatabasePath);
  closedMetadata.close();
  closedStore.close();
  const rollbackSecrets = new ControlledSecretStore();
  rollbackSecrets.failDelete = true;
  const rollbackRegistry = new TranscriptionCredentialRegistry({
    metadata: closedMetadata,
    secretStore: rollbackSecrets,
  });
  await assert.rejects(
    rollbackRegistry.configure({
      credential: 'rollback-canary',
      provider: 'groq',
    }),
    /credential update failed and Keychain rollback failed/,
  );
});
