import Database from 'better-sqlite3';

import type { TranscriptionProviderName } from '../../../packages/transcription/src/index.ts';
import { StoreError } from './store.ts';

export type ProviderCredentialMetadata = {
  createdAt: string;
  keychainAccount: string;
  lastValidatedAt: string | null;
  provider: TranscriptionProviderName;
  selected: boolean;
  status: 'configured' | 'invalid' | 'valid';
  updatedAt: string;
};

type ProviderCredentialRow = {
  created_at: string;
  keychain_account: string;
  last_validated_at: string | null;
  provider: TranscriptionProviderName;
  selected: number;
  status: 'configured' | 'invalid' | 'valid';
  updated_at: string;
};

export class ProviderMetadataStore {
  readonly #database: Database.Database;

  constructor(databasePath: string) {
    this.#database = new Database(databasePath);
  }

  close(): void {
    this.#database.close();
  }

  list(): ProviderCredentialMetadata[] {
    const rows = this.#database
      .prepare(
        `SELECT provider, keychain_account, status, selected, created_at,
                updated_at, last_validated_at
         FROM transcription_provider_credentials
         ORDER BY provider`,
      )
      .all() as ProviderCredentialRow[];
    return rows.map((row) => ({
      createdAt: row.created_at,
      keychainAccount: row.keychain_account,
      lastValidatedAt: row.last_validated_at,
      provider: row.provider,
      selected: row.selected === 1,
      status: row.status,
      updatedAt: row.updated_at,
    }));
  }

  markValidated(provider: TranscriptionProviderName, valid: boolean): void {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare(
        `UPDATE transcription_provider_credentials
         SET status = ?, last_validated_at = ?, updated_at = ?
         WHERE provider = ?`,
      )
      .run(valid ? 'valid' : 'invalid', now, now, provider);
    if (result.changes === 0) {
      throw new StoreError('NOT_FOUND', `${provider} is not configured`);
    }
  }

  remove(provider: TranscriptionProviderName): void {
    this.#database
      .prepare(
        'DELETE FROM transcription_provider_credentials WHERE provider = ?',
      )
      .run(provider);
  }

  selected(): ProviderCredentialMetadata | undefined {
    return this.list().find((record) => record.selected);
  }

  select(provider: TranscriptionProviderName): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const exists = this.#database
        .prepare(
          'SELECT 1 FROM transcription_provider_credentials WHERE provider = ?',
        )
        .get(provider);
      if (!exists) {
        throw new StoreError('NOT_FOUND', `${provider} is not configured`);
      }
      this.#database
        .prepare(
          'UPDATE transcription_provider_credentials SET selected = 0 WHERE selected = 1',
        )
        .run();
      this.#database
        .prepare(
          `UPDATE transcription_provider_credentials
           SET selected = 1, updated_at = ? WHERE provider = ?`,
        )
        .run(new Date().toISOString(), provider);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  upsert(input: {
    keychainAccount: string;
    provider: TranscriptionProviderName;
    select: boolean;
  }): void {
    const now = new Date().toISOString();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      if (input.select) {
        this.#database
          .prepare(
            'UPDATE transcription_provider_credentials SET selected = 0 WHERE selected = 1',
          )
          .run();
      }
      this.#database
        .prepare(
          `INSERT INTO transcription_provider_credentials
           (provider, keychain_account, status, selected, created_at, updated_at,
            last_validated_at)
           VALUES (?, ?, 'configured', ?, ?, ?, NULL)
           ON CONFLICT(provider) DO UPDATE SET
             keychain_account = excluded.keychain_account,
             status = 'configured',
             selected = excluded.selected,
             updated_at = excluded.updated_at,
             last_validated_at = NULL`,
        )
        .run(
          input.provider,
          input.keychainAccount,
          input.select ? 1 : 0,
          now,
          now,
        );
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }
}

export function openProviderMetadataStore(
  databasePath: string,
): ProviderMetadataStore {
  return new ProviderMetadataStore(databasePath);
}
