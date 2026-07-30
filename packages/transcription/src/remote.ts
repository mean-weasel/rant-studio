import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

import type {
  ProviderWord,
  TranscriptProvider,
  TranscriptProviderInput,
  TranscriptProviderResult,
} from './types.ts';

type RemoteProviderOptions = {
  apiKey: string;
  endpoint?: string;
  fetch?: typeof fetch;
  language?: string;
};

type RemoteWord = {
  end?: unknown;
  start?: unknown;
  text?: unknown;
  word?: unknown;
};

const OPENAI_MAX_BYTES = 25 * 1024 * 1024;
const MAX_WORD_OVERLAP_MS = 2_000;

function uploadSource(input: TranscriptProviderInput): {
  mimeType: string;
  name: string;
  path: string;
} {
  const path = input.originalPath ?? input.managedPath;
  return {
    mimeType: input.originalMimeType ?? input.mimeType,
    name: input.originalName ?? basename(path),
    path,
  };
}

function secondsToMilliseconds(value: number): number {
  return Math.max(0, Math.round(value * 1000));
}

function parseWords(
  raw: unknown,
  provider: string,
  textField: 'text' | 'word',
): ProviderWord[] {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${provider} returned a non-object transcription`);
  }
  const remoteWords = (raw as { words?: unknown }).words;
  if (!Array.isArray(remoteWords) || remoteWords.length === 0) {
    throw new Error(`${provider} returned no word timestamps`);
  }
  let previousEndMs = 0;
  return remoteWords.map((candidate, index) => {
    const word = candidate as RemoteWord;
    const text = word[textField];
    if (
      typeof text !== 'string' ||
      text.trim().length === 0 ||
      typeof word.start !== 'number' ||
      !Number.isFinite(word.start) ||
      typeof word.end !== 'number' ||
      !Number.isFinite(word.end)
    ) {
      throw new Error(`${provider} returned an invalid word at index ${index}`);
    }
    const rawStartMs = secondsToMilliseconds(word.start);
    const rawEndMs = secondsToMilliseconds(word.end);
    if (rawEndMs <= rawStartMs) {
      throw new Error(
        `${provider} returned invalid word timing at index ${index}`,
      );
    }
    const overlapMs = Math.max(0, previousEndMs - rawStartMs);
    if (overlapMs > MAX_WORD_OVERLAP_MS) {
      throw new Error(
        `${provider} returned non-chronological word timing at index ${index}`,
      );
    }
    const startMs = Math.max(rawStartMs, previousEndMs);
    const endMs = Math.max(rawEndMs, startMs + 1);
    previousEndMs = endMs;
    return { endMs, startMs, text: text.trim() };
  });
}

function redactSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join('[REDACTED]') : message;
}

async function providerError(
  response: Response,
  provider: string,
  secret: string,
) {
  let detail = '';
  try {
    const raw = (await response.json()) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    const message = raw.error?.message ?? raw.message;
    if (typeof message === 'string') {
      detail = `: ${redactSecret(message, secret).slice(0, 300)}`;
    }
  } catch {
    // The status remains enough evidence when the provider does not return JSON.
  }
  return new Error(
    `${provider} transcription failed (${response.status} ${response.statusText})${detail}`,
  );
}

abstract class RemoteTranscriptProvider implements TranscriptProvider {
  abstract readonly name: string;
  abstract transcribe(
    input: TranscriptProviderInput,
  ): Promise<TranscriptProviderResult>;
  protected readonly apiKey: string;
  protected readonly endpoint: string;
  protected readonly fetch: typeof fetch;
  protected readonly language?: string;

  constructor(options: RemoteProviderOptions, defaultEndpoint: string) {
    if (!options.apiKey.trim())
      throw new Error('Transcription API key required');
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? defaultEndpoint;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.language = options.language;
  }

  protected async upload(
    form: FormData,
    input: TranscriptProviderInput,
  ): Promise<unknown> {
    const source = uploadSource(input);
    const bytes = await readFile(source.path);
    form.append(
      'file',
      new Blob([bytes], { type: source.mimeType }),
      source.name,
    );
    const response = await this.fetch(this.endpoint, {
      body: form,
      headers: { authorization: `Bearer ${this.apiKey}` },
      method: 'POST',
    });
    if (!response.ok) {
      throw await providerError(response, this.name, this.apiKey);
    }
    return response.json();
  }
}

export class OpenAITranscriptProvider extends RemoteTranscriptProvider {
  readonly name = 'openai:whisper-1';

  constructor(options: RemoteProviderOptions) {
    super(options, 'https://api.openai.com/v1/audio/transcriptions');
  }

  async transcribe(
    input: TranscriptProviderInput,
  ): Promise<TranscriptProviderResult> {
    const source = uploadSource(input);
    if ((await stat(source.path)).size > OPENAI_MAX_BYTES) {
      throw new Error(
        'OpenAI transcription accepts files up to 25 MB; use a compressed narration source or the Groq provider',
      );
    }
    const form = new FormData();
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    if (this.language) form.append('language', this.language);
    const raw = await this.upload(form, input);
    return { raw, words: parseWords(raw, this.name, 'word') };
  }
}

export class GroqTranscriptProvider extends RemoteTranscriptProvider {
  readonly name = 'groq:whisper-large-v3-turbo';

  constructor(options: RemoteProviderOptions) {
    super(options, 'https://api.groq.com/openai/v1/audio/transcriptions');
  }

  async transcribe(
    input: TranscriptProviderInput,
  ): Promise<TranscriptProviderResult> {
    const form = new FormData();
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    if (this.language) form.append('language', this.language);
    const raw = await this.upload(form, input);
    return { raw, words: parseWords(raw, this.name, 'word') };
  }
}
