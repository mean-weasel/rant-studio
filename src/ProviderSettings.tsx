import { useCallback, useEffect, useState } from 'react';

import './ProviderSettings.css';

type ProviderName = 'groq' | 'openai';

type ProviderStatus = {
  configured: boolean;
  lastValidatedAt: string | null;
  provider: ProviderName;
  selected: boolean;
  source: 'environment' | 'keychain' | null;
  status: 'configured' | 'invalid' | 'missing' | 'valid';
};

type ProviderSnapshot = {
  activeProvider: 'deterministic' | ProviderName;
  activeSource: 'deterministic' | 'environment' | 'keychain';
  providers: ProviderStatus[];
};

type ProviderSettingsProps = {
  baseUrl: string;
};

const names: Record<ProviderName, string> = {
  groq: 'Groq',
  openai: 'OpenAI',
};

function providerError(error: unknown): string {
  return error instanceof Error ? error.message : 'Provider request failed';
}

export function ProviderSettings({ baseUrl }: ProviderSettingsProps) {
  const [snapshot, setSnapshot] = useState<ProviderSnapshot | null>(null);
  const [keys, setKeys] = useState<Record<ProviderName, string>>({
    groq: '',
    openai: '',
  });
  const [busy, setBusy] = useState<ProviderName | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<ProviderName | null>(
    null,
  );
  const [message, setMessage] = useState('Loading provider readiness…');

  const request = useCallback(
    async (path = '', init?: RequestInit) => {
      const response = await fetch(
        `${baseUrl.replace(/\/$/, '')}/v1/transcription-providers${path}`,
        {
          ...init,
          headers: {
            'content-type': 'application/json',
            ...init?.headers,
          },
        },
      );
      const payload = (await response.json()) as
        ProviderSnapshot | { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(
          'error' in payload
            ? (payload.error?.message ?? 'Provider request failed')
            : 'Provider request failed',
        );
      }
      return payload as ProviderSnapshot;
    },
    [baseUrl],
  );

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await request());
      setMessage('Provider readiness is shared with connected agents.');
    } catch (error) {
      setMessage(providerError(error));
    }
  }, [request]);

  useEffect(() => {
    let active = true;
    void request().then(
      (next) => {
        if (!active) return;
        setSnapshot(next);
        setMessage('Provider readiness is shared with connected agents.');
      },
      (error: unknown) => {
        if (active) setMessage(providerError(error));
      },
    );
    return () => {
      active = false;
    };
  }, [request]);

  async function act(
    provider: ProviderName,
    label: string,
    path: string,
    init: RequestInit,
  ) {
    setBusy(provider);
    setMessage(label);
    try {
      setSnapshot(await request(`/${provider}/${path}`, init));
      setMessage(`${label} complete.`);
      setPendingRemoval(null);
    } catch (error) {
      setMessage(providerError(error));
    } finally {
      setBusy(null);
    }
  }

  async function save(provider: ProviderName) {
    const key = keys[provider];
    if (!key.trim()) return;
    setKeys((current) => ({ ...current, [provider]: '' }));
    await act(provider, `Saving ${names[provider]} credential`, 'credential', {
      body: JSON.stringify({ credential: key, select: true }),
      method: 'PUT',
    });
  }

  return (
    <section
      className="intake-card provider-settings"
      aria-labelledby="provider-settings-heading"
    >
      <div className="provider-settings-heading">
        <div>
          <p className="eyebrow">Human + agent configuration</p>
          <h2 id="provider-settings-heading">Transcription providers</h2>
        </div>
        <button type="button" disabled={busy !== null} onClick={refresh}>
          Refresh readiness
        </button>
      </div>
      <p>
        Saved keys live in macOS Keychain and are write-only here. Agents can
        see readiness and the active provider, never the saved value.
      </p>
      <p className="provider-active">
        Active:{' '}
        <strong>
          {snapshot
            ? `${snapshot.activeProvider} · ${snapshot.activeSource}`
            : 'checking…'}
        </strong>
      </p>
      <div className="provider-grid">
        {(['openai', 'groq'] as const).map((provider) => {
          const status = snapshot?.providers.find(
            (candidate) => candidate.provider === provider,
          );
          const isBusy = busy === provider;
          const confirming = pendingRemoval === provider;
          return (
            <article className="provider-card" key={provider}>
              <div className="provider-card-heading">
                <h3>{names[provider]}</h3>
                <span data-provider-status={status?.status ?? 'missing'}>
                  {status?.status ?? 'missing'}
                </span>
              </div>
              <dl className="provider-facts">
                <div>
                  <dt>Source</dt>
                  <dd>{status?.source ?? 'not configured'}</dd>
                </div>
                <div>
                  <dt>Selection</dt>
                  <dd>{status?.selected ? 'active' : 'standby'}</dd>
                </div>
                <div>
                  <dt>Last tested</dt>
                  <dd>{status?.lastValidatedAt ?? 'not yet'}</dd>
                </div>
              </dl>
              <label>
                {names[provider]} API key
                <input
                  autoComplete="off"
                  type="password"
                  value={keys[provider]}
                  onChange={(event) =>
                    setKeys((current) => ({
                      ...current,
                      [provider]: event.target.value,
                    }))
                  }
                />
              </label>
              <div className="provider-actions">
                <button
                  type="button"
                  disabled={busy !== null || !keys[provider].trim()}
                  onClick={() => void save(provider)}
                >
                  {status?.configured ? 'Replace' : 'Save'} {names[provider]}{' '}
                  key
                </button>
                <button
                  type="button"
                  disabled={busy !== null || !status?.configured}
                  onClick={() =>
                    void act(provider, `Testing ${names[provider]}`, 'test', {
                      method: 'POST',
                    })
                  }
                >
                  Test {names[provider]}
                </button>
                <button
                  type="button"
                  disabled={
                    busy !== null || !status?.configured || status.selected
                  }
                  onClick={() =>
                    void act(
                      provider,
                      `Selecting ${names[provider]}`,
                      'select',
                      { method: 'POST' },
                    )
                  }
                >
                  Select {names[provider]}
                </button>
              </div>
              {confirming ? (
                <div className="provider-confirm" role="group">
                  <span>Remove this saved Keychain credential?</span>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() =>
                      void act(
                        provider,
                        `Removing ${names[provider]} credential`,
                        'credential',
                        { method: 'DELETE' },
                      )
                    }
                  >
                    Confirm remove
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => setPendingRemoval(null)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  className="provider-remove"
                  type="button"
                  disabled={busy !== null || status?.source !== 'keychain'}
                  onClick={() => setPendingRemoval(provider)}
                >
                  Remove saved {names[provider]} key
                </button>
              )}
            </article>
          );
        })}
      </div>
      <p className="provider-message" role="status" aria-live="polite">
        {message}
      </p>
    </section>
  );
}
