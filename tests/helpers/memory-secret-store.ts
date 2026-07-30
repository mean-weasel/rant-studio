import type { SecretStore } from '../../apps/service/src/credential-store.ts';
import type { TranscriptionProviderName } from '../../packages/transcription/src/index.ts';

export class MemorySecretStore implements SecretStore {
  readonly #secrets = new Map<TranscriptionProviderName, string>();

  async delete(provider: TranscriptionProviderName): Promise<void> {
    this.#secrets.delete(provider);
  }

  async get(provider: TranscriptionProviderName): Promise<string | undefined> {
    return this.#secrets.get(provider);
  }

  async set(
    provider: TranscriptionProviderName,
    secret: string,
  ): Promise<void> {
    this.#secrets.set(provider, secret);
  }
}
