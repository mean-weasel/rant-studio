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
};

export interface TranscriptProvider {
  readonly name: string;
  transcribe(input: TranscriptProviderInput): Promise<TranscriptProviderResult>;
}

export class DeterministicTranscriptProvider implements TranscriptProvider {
  readonly name = 'deterministic';

  constructor(
    private readonly fixture: TranscriptProviderResult = {
      raw: {
        provider: 'deterministic',
        words: [
          { text: 'Rant', startMs: 0, endMs: 320 },
          { text: 'Studio', startMs: 320, endMs: 760 },
        ],
      },
      words: [
        { text: 'Rant', startMs: 0, endMs: 320 },
        { text: 'Studio', startMs: 320, endMs: 760 },
      ],
    },
  ) {}

  async transcribe(): Promise<TranscriptProviderResult> {
    return structuredClone(this.fixture);
  }
}
