export type ProviderWord = {
  text: string;
  startMs: number;
  endMs: number;
};

export type TranscriptProviderResult = {
  raw: unknown;
  words: ProviderWord[];
};

export type TranscriptProviderInput = {
  checksum: string;
  managedPath: string;
  mimeType: string;
  originalName?: string;
  originalPath?: string;
  originalMimeType?: string;
};

export interface TranscriptProvider {
  readonly name: string;
  transcribe(input: TranscriptProviderInput): Promise<TranscriptProviderResult>;
}

export type TranscriptionProviderName = 'groq' | 'openai';
