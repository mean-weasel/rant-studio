import type { TranscriptProvider, TranscriptProviderResult } from './types.ts';

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
