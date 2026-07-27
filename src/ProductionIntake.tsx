import { useCallback, useMemo, useState } from 'react';

import { RantApiError, RantClient } from '../packages/api/src/index';
import type { IntakeProjectSnapshot } from '../packages/model/src/index';
import { ProductionEditorial } from './ProductionEditorial';
import { TranscriptNavigator } from './TranscriptNavigator';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function messageFor(error: unknown): string {
  if (error instanceof RantApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : 'Unknown intake error';
}

export function ProductionIntake() {
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:4174');
  const [credential, setCredential] = useState('');
  const [connected, setConnected] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [existingProjectId, setExistingProjectId] = useState('');
  const [project, setProject] = useState<IntakeProjectSnapshot | null>(null);
  const [narration, setNarration] = useState<File | null>(null);
  const [transcriptJson, setTranscriptJson] = useState(
    '{\n  "words": [\n    { "text": "Hello", "startMs": 0, "endMs": 500 }\n  ]\n}',
  );
  const [status, setStatus] = useState('Connect to the loopback service to begin.');
  const [busy, setBusy] = useState(false);
  const client = useMemo(
    () => new RantClient({ baseUrl, credential }),
    [baseUrl, credential],
  );
  const handleRevision = useCallback((revision: number) => {
    setProject((current) => (current ? { ...current, revision } : current));
  }, []);

  async function perform(label: string, work: () => Promise<IntakeProjectSnapshot>) {
    setBusy(true);
    setStatus(label);
    try {
      const next = await work();
      setProject(next);
      setStatus(`${label} complete. Revision ${next.revision}.`);
    } catch (error) {
      setStatus(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  async function createProject() {
    setBusy(true);
    setStatus('Creating project…');
    try {
      const created = await client.createProject(projectName);
      const intake = await client.getIntake(created.id);
      setProject(intake);
      setStatus(`Project created. Revision ${intake.revision}.`);
    } catch (error) {
      setStatus(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  async function openProject() {
    setBusy(true);
    setStatus('Opening durable project…');
    try {
      const intake = await client.getIntake(existingProjectId.trim());
      setProject(intake);
      setStatus(`Project reopened. Revision ${intake.revision}.`);
    } catch (error) {
      setStatus(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  async function uploadNarration() {
    if (!project || !narration) return;
    const bytes = new Uint8Array(await narration.arrayBuffer());
    await perform('Uploading narration', () =>
      client.uploadNarration(project.id, {
        bytesBase64: bytesToBase64(bytes),
        expectedRevision: project.revision,
        mimeType: narration.type || 'audio/wav',
        originalName: narration.name,
      }),
    );
  }

  async function importTranscript() {
    if (!project) return;
    try {
      const raw = JSON.parse(transcriptJson) as {
        words?: Array<{ text: string; startMs: number; endMs: number }>;
      };
      await perform('Importing timestamp transcript', () =>
        client.importTranscript(project.id, {
          expectedRevision: project.revision,
          raw,
          words: raw.words ?? [],
        }),
      );
    } catch (error) {
      setStatus(`INVALID_JSON: ${messageFor(error)}`);
    }
  }

  return (
    <main className="intake-shell">
      <header className="intake-hero">
        <div>
          <p className="eyebrow">Rant Studio · Production workspace</p>
          <h1>Project intake</h1>
          <p>
            Add narration, preserve its source, and create an untouched
            word-timestamp transcript before editorial work begins.
          </p>
        </div>
        <a href="/">Open UX prototype</a>
      </header>

      {!connected ? (
        <section className="intake-card" aria-labelledby="connection-heading">
          <h2 id="connection-heading">Local service</h2>
          <label>
            Local service URL
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <label>
            Local credential
            <input
              type="password"
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={!baseUrl || !credential}
            onClick={() => {
              setConnected(true);
              setStatus('Connected. Create or open a project.');
            }}
          >
            Connect
          </button>
        </section>
      ) : null}

      <p className="intake-status" role="status" aria-live="polite">
        {status}
      </p>

      {connected && !project ? (
        <div className="intake-grid">
          <section className="intake-card" aria-labelledby="new-project-heading">
            <h2 id="new-project-heading">New project</h2>
            <label>
              Project name
              <input
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={busy || !projectName.trim()}
              onClick={createProject}
            >
              Create project
            </button>
          </section>
          <section className="intake-card" aria-labelledby="existing-project-heading">
            <h2 id="existing-project-heading">Open existing project</h2>
            <p>Reconnect to the durable project after a browser or service restart.</p>
            <label>
              Existing project ID
              <input
                value={existingProjectId}
                onChange={(event) => setExistingProjectId(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={busy || !existingProjectId.trim()}
              onClick={openProject}
            >
              Open existing project
            </button>
          </section>
        </div>
      ) : null}

      {project ? (
        <>
          <section className="intake-project" aria-labelledby="project-heading">
            <div>
              <p className="eyebrow">Revision {project.revision}</p>
              <h2 id="project-heading">{project.name}</h2>
            </div>
            <code>{project.id}</code>
          </section>

          <div className="intake-grid">
            <section className="intake-card" aria-labelledby="audio-heading">
              <h2 id="audio-heading">1 · Narration</h2>
              <p>WAV is supported in V1. The service validates and copies it.</p>
              <label>
                Narration WAV
                <input
                  type="file"
                  accept=".wav,audio/wav"
                  onChange={(event) => setNarration(event.target.files?.[0] ?? null)}
                />
              </label>
              <button
                type="button"
                disabled={busy || !narration}
                onClick={uploadNarration}
              >
                Upload narration
              </button>
              {project.sourceAudio ? (
                <dl className="intake-facts">
                  <div>
                    <dt>Source</dt>
                    <dd>{project.sourceAudio.originalName}</dd>
                  </div>
                  <div>
                    <dt>Checksum</dt>
                    <dd>
                      <code>{project.sourceAudio.checksum.slice(0, 16)}…</code>
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="intake-empty">No narration uploaded.</p>
              )}
            </section>

            <section className="intake-card" aria-labelledby="transcribe-heading">
              <h2 id="transcribe-heading">2 · Transcript</h2>
              <p>
                Run the deterministic adapter, or import provider-compatible JSON.
                Retries create new attempts.
              </p>
              <button
                type="button"
                disabled={busy || !project.sourceAudio}
                onClick={() =>
                  perform('Transcribing', () =>
                    client.runTranscription(project.id, {
                      expectedRevision: project.revision,
                    }),
                  )
                }
              >
                Transcribe deterministically
              </button>
              <details>
                <summary>Import timestamp JSON</summary>
                <label>
                  Timestamp JSON
                  <textarea
                    rows={8}
                    value={transcriptJson}
                    onChange={(event) => setTranscriptJson(event.target.value)}
                  />
                </label>
                <button type="button" disabled={busy} onClick={importTranscript}>
                  Import transcript
                </button>
              </details>
              <ul className="attempt-list" aria-label="Transcription attempts">
                {project.attempts.map((attempt) => (
                  <li key={attempt.id}>
                    <span>{attempt.provider}</span>
                    <strong data-status={attempt.status}>{attempt.status}</strong>
                    {attempt.errorMessage ? <small>{attempt.errorMessage}</small> : null}
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <section className="intake-card transcript-result" aria-labelledby="raw-heading">
            <p className="eyebrow">Untouched provider result</p>
            <h2 id="raw-heading">Raw transcript</h2>
            {project.transcript ? (
              <>
                <TranscriptNavigator
                  label="Raw transcript"
                  words={project.transcript.words}
                />
                {project.transcript.words.length <= 80 ? (
                  <div className="intake-table-wrap">
                    <table aria-label="Word timestamps">
                      <thead>
                        <tr>
                          <th scope="col">Word</th>
                          <th scope="col">Source timing</th>
                        </tr>
                      </thead>
                      <tbody>
                        {project.transcript.words.map((word) => (
                          <tr key={word.id}>
                            <td>{word.text}</td>
                            <td>
                              {word.startMs}–{word.endMs} ms
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="intake-empty">No transcript yet.</p>
            )}
          </section>
          {project.transcript ? (
            <ProductionEditorial
              client={client}
              projectId={project.id}
              onRevision={handleRevision}
            />
          ) : null}
        </>
      ) : null}
    </main>
  );
}
