import { DeterministicTranscriptProvider } from './deterministic.ts';
import { GroqTranscriptProvider, OpenAITranscriptProvider } from './remote.ts';
import type { TranscriptProvider, TranscriptionProviderName } from './types.ts';

export type TranscriptionEnvironment = {
  GROQ_API_KEY?: string;
  OPENAI_API_KEY?: string;
  RANT_STUDIO_TRANSCRIPTION_LANGUAGE?: string;
  RANT_STUDIO_TRANSCRIPTION_PROVIDER?: string;
};

function requiredKey(value: string | undefined, variable: string): string {
  if (value?.trim()) return value;
  throw new Error(`${variable} is required for the selected provider`);
}

export function transcriptProviderFromConfiguration(input: {
  apiKey: string;
  language?: string;
  provider: TranscriptionProviderName;
}): TranscriptProvider {
  return input.provider === 'openai'
    ? new OpenAITranscriptProvider(input)
    : new GroqTranscriptProvider(input);
}

export function transcriptProviderFromEnvironment(
  environment: TranscriptionEnvironment,
): TranscriptProvider {
  const provider = (
    environment.RANT_STUDIO_TRANSCRIPTION_PROVIDER ?? 'deterministic'
  ).toLowerCase();
  const language = environment.RANT_STUDIO_TRANSCRIPTION_LANGUAGE;
  if (provider === 'deterministic') {
    return new DeterministicTranscriptProvider();
  }
  if (provider === 'openai') {
    return transcriptProviderFromConfiguration({
      apiKey: requiredKey(environment.OPENAI_API_KEY, 'OPENAI_API_KEY'),
      language,
      provider: 'openai',
    });
  }
  if (provider === 'groq') {
    return transcriptProviderFromConfiguration({
      apiKey: requiredKey(environment.GROQ_API_KEY, 'GROQ_API_KEY'),
      language,
      provider: 'groq',
    });
  }
  throw new Error(
    'RANT_STUDIO_TRANSCRIPTION_PROVIDER must be deterministic, openai, or groq',
  );
}
