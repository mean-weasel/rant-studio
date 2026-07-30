import { spawn } from 'node:child_process';

import {
  DeterministicTranscriptProvider,
  transcriptProviderFromConfiguration,
  transcriptProviderFromEnvironment,
  type TranscriptProvider,
  type TranscriptionEnvironment,
  type TranscriptionProviderName,
} from '../../../packages/transcription/src/index.ts';
import type { ProviderMetadataStore } from './provider-metadata.ts';

export interface SecretStore {
  delete(provider: TranscriptionProviderName): Promise<void>;
  get(provider: TranscriptionProviderName): Promise<string | undefined>;
  set(provider: TranscriptionProviderName, secret: string): Promise<void>;
}

type SecurityResult = {
  code: number;
  stderr: string;
  stdout: string;
};

function runSecurity(args: string[], input?: string): Promise<SecurityResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stderr.setEncoding('utf8');
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code: code ?? 1, stderr, stdout });
    });
    child.stdin.end(input === undefined ? undefined : `${input}\n`);
  });
}

const keychainWriteScript = `
set timeout 10
log_user 0
set account $env(RANT_STUDIO_KEYCHAIN_ACCOUNT)
set service $env(RANT_STUDIO_KEYCHAIN_SERVICE)
gets stdin password
spawn -noecho /usr/bin/security add-generic-password -U -a $account -s $service -w
expect {
  "password data for new item:" {}
  timeout { exit 124 }
  eof {
    set result [wait]
    exit [lindex $result 3]
  }
}
send -- "$password\\r"
expect {
  "retype password for new item:" {}
  timeout { exit 124 }
  eof {
    set result [wait]
    exit [lindex $result 3]
  }
}
send -- "$password\\r"
expect eof
set result [wait]
exit [lindex $result 3]
`.trim();

function writeSecurityPassword(input: {
  account: string;
  password: string;
  service: string;
}): Promise<SecurityResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/expect', ['-c', keychainWriteScript], {
      env: {
        ...process.env,
        RANT_STUDIO_KEYCHAIN_ACCOUNT: input.account,
        RANT_STUDIO_KEYCHAIN_SERVICE: input.service,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stderr.setEncoding('utf8');
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code: code ?? 1, stderr, stdout });
    });
    child.stdin.end(`${input.password}\n`);
  });
}

export class MacOSKeychainSecretStore implements SecretStore {
  constructor(
    private readonly service = 'com.mean-weasel.rant-studio.transcription',
  ) {}

  async delete(provider: TranscriptionProviderName): Promise<void> {
    this.#assertMacOS();
    const result = await runSecurity([
      'delete-generic-password',
      '-a',
      provider,
      '-s',
      this.service,
    ]);
    if (result.code !== 0 && !this.#isMissing(result.stderr)) {
      throw new Error('Unable to remove the provider credential from Keychain');
    }
  }

  async get(provider: TranscriptionProviderName): Promise<string | undefined> {
    this.#assertMacOS();
    const result = await runSecurity([
      'find-generic-password',
      '-a',
      provider,
      '-s',
      this.service,
      '-w',
    ]);
    if (result.code !== 0) {
      if (this.#isMissing(result.stderr)) return undefined;
      throw new Error('Unable to read the provider credential from Keychain');
    }
    return result.stdout.replace(/\r?\n$/, '');
  }

  async set(
    provider: TranscriptionProviderName,
    secret: string,
  ): Promise<void> {
    this.#assertMacOS();
    const result = await writeSecurityPassword({
      account: provider,
      password: secret,
      service: this.service,
    });
    if (result.code !== 0) {
      throw new Error('Unable to save the provider credential in Keychain');
    }
  }

  #assertMacOS(): void {
    if (process.platform !== 'darwin') {
      throw new Error('Persistent provider credentials require macOS Keychain');
    }
  }

  #isMissing(stderr: string): boolean {
    return (
      stderr.includes('could not be found') ||
      stderr.includes('The specified item could not be found')
    );
  }
}

export type ProviderStatus = {
  configured: boolean;
  createdAt: string | null;
  lastValidatedAt: string | null;
  provider: TranscriptionProviderName;
  selected: boolean;
  source: 'environment' | 'keychain' | null;
  status: 'configured' | 'invalid' | 'missing' | 'valid';
  updatedAt: string | null;
};

export type ProviderRegistrySnapshot = {
  activeProvider: 'deterministic' | TranscriptionProviderName;
  activeSource: 'deterministic' | 'environment' | 'keychain';
  providers: ProviderStatus[];
};

type RegistryOptions = {
  environment?: TranscriptionEnvironment;
  fetch?: typeof fetch;
  metadata: ProviderMetadataStore;
  secretStore: SecretStore;
};

const providers: TranscriptionProviderName[] = ['openai', 'groq'];

function environmentKey(
  environment: TranscriptionEnvironment,
  provider: TranscriptionProviderName,
): string | undefined {
  return provider === 'openai'
    ? environment.OPENAI_API_KEY
    : environment.GROQ_API_KEY;
}

function selectedEnvironmentProvider(
  environment: TranscriptionEnvironment,
): 'deterministic' | TranscriptionProviderName | undefined {
  const selected =
    environment.RANT_STUDIO_TRANSCRIPTION_PROVIDER?.toLowerCase();
  if (!selected) return undefined;
  if (
    selected === 'deterministic' ||
    selected === 'openai' ||
    selected === 'groq'
  ) {
    return selected as 'deterministic' | TranscriptionProviderName;
  }
  throw new Error(
    'RANT_STUDIO_TRANSCRIPTION_PROVIDER must be deterministic, openai, or groq',
  );
}

export class TranscriptionCredentialRegistry {
  readonly #environment: TranscriptionEnvironment;
  readonly #fetch: typeof fetch;
  readonly #metadata: ProviderMetadataStore;
  readonly #secretStore: SecretStore;
  #mutationQueue = Promise.resolve();

  constructor(options: RegistryOptions) {
    this.#environment = options.environment ?? {};
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#metadata = options.metadata;
    this.#secretStore = options.secretStore;
  }

  async configure(input: {
    credential: string;
    provider: TranscriptionProviderName;
    select?: boolean;
  }): Promise<ProviderRegistrySnapshot> {
    return this.#mutate(async () => {
      const credential = input.credential.trim();
      if (!credential) throw new Error('Provider credential is required');
      const previous = await this.#secretStore.get(input.provider);
      try {
        await this.#secretStore.set(input.provider, credential);
        this.#metadata.upsert({
          keychainAccount: input.provider,
          provider: input.provider,
          select: input.select !== false,
        });
      } catch (error) {
        await this.#rollback(input.provider, previous, error);
        throw error;
      }
      return this.#snapshot();
    });
  }

  async remove(
    provider: TranscriptionProviderName,
  ): Promise<ProviderRegistrySnapshot> {
    return this.#mutate(async () => {
      const previous = await this.#secretStore.get(provider);
      try {
        await this.#secretStore.delete(provider);
        this.#metadata.remove(provider);
      } catch (error) {
        await this.#rollback(provider, previous, error);
        throw error;
      }
      return this.#snapshot();
    });
  }

  async resolveProvider(): Promise<TranscriptProvider> {
    await this.#mutationQueue;
    const selectedEnvironment = selectedEnvironmentProvider(this.#environment);
    if (selectedEnvironment) {
      return transcriptProviderFromEnvironment(this.#environment);
    }
    const selected = this.#metadata.selected();
    if (!selected) return new DeterministicTranscriptProvider();
    const credential = await this.#secretStore.get(selected.provider);
    if (!credential) {
      throw new Error(
        `${selected.provider} is selected but its Keychain credential is missing`,
      );
    }
    return transcriptProviderFromConfiguration({
      apiKey: credential,
      language: this.#environment.RANT_STUDIO_TRANSCRIPTION_LANGUAGE,
      provider: selected.provider,
    });
  }

  async select(
    provider: TranscriptionProviderName,
  ): Promise<ProviderRegistrySnapshot> {
    return this.#mutate(async () => {
      if (!(await this.#secretStore.get(provider))) {
        throw new Error(`Configure ${provider} before selecting it`);
      }
      this.#metadata.select(provider);
      return this.#snapshot();
    });
  }

  async snapshot(): Promise<ProviderRegistrySnapshot> {
    await this.#mutationQueue;
    return this.#snapshot();
  }

  async #snapshot(): Promise<ProviderRegistrySnapshot> {
    const metadata = new Map(
      this.#metadata.list().map((record) => [record.provider, record]),
    );
    const environmentProvider = selectedEnvironmentProvider(this.#environment);
    const selectedKeychain = this.#metadata.selected()?.provider;
    const statuses = await Promise.all(
      providers.map(async (provider): Promise<ProviderStatus> => {
        const record = metadata.get(provider);
        const envCredential = environmentKey(this.#environment, provider);
        const keychainConfigured =
          record !== undefined &&
          (await this.#secretStore.get(provider)) !== undefined;
        const source = envCredential?.trim()
          ? 'environment'
          : keychainConfigured
            ? 'keychain'
            : null;
        return {
          configured: source !== null,
          createdAt: record?.createdAt ?? null,
          lastValidatedAt: record?.lastValidatedAt ?? null,
          provider,
          selected:
            environmentProvider === provider ||
            (!environmentProvider && selectedKeychain === provider),
          source,
          status:
            source === null
              ? 'missing'
              : source === 'environment'
                ? 'configured'
                : record?.status === 'invalid'
                  ? 'invalid'
                  : record?.status === 'valid'
                    ? 'valid'
                    : 'configured',
          updatedAt: record?.updatedAt ?? null,
        };
      }),
    );
    const activeProvider =
      environmentProvider ??
      statuses.find((status) => status.selected)?.provider ??
      'deterministic';
    return {
      activeProvider,
      activeSource: environmentProvider
        ? environmentProvider === 'deterministic'
          ? 'deterministic'
          : 'environment'
        : activeProvider === 'deterministic'
          ? 'deterministic'
          : 'keychain',
      providers: statuses,
    };
  }

  async test(
    provider: TranscriptionProviderName,
  ): Promise<ProviderRegistrySnapshot> {
    return this.#mutate(async () => {
      const credential =
        environmentKey(this.#environment, provider) ??
        (await this.#secretStore.get(provider));
      if (!credential?.trim()) throw new Error(`Configure ${provider} first`);
      const endpoint =
        provider === 'openai'
          ? 'https://api.openai.com/v1/models'
          : 'https://api.groq.com/openai/v1/models';
      const response = await this.#fetch(endpoint, {
        headers: { authorization: `Bearer ${credential}` },
      });
      const valid = response.ok;
      if (!environmentKey(this.#environment, provider)) {
        this.#metadata.markValidated(provider, valid);
      }
      if (!valid) {
        throw new Error(
          `${provider} credential validation failed (${response.status} ${response.statusText})`,
        );
      }
      return this.#snapshot();
    });
  }

  #mutate<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#mutationQueue.then(work, work);
    this.#mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #rollback(
    provider: TranscriptionProviderName,
    previous: string | undefined,
    originalError: unknown,
  ): Promise<void> {
    try {
      if (previous === undefined) {
        await this.#secretStore.delete(provider);
      } else {
        await this.#secretStore.set(provider, previous);
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [originalError, rollbackError],
        'Provider credential update failed and Keychain rollback failed',
      );
    }
  }
}
