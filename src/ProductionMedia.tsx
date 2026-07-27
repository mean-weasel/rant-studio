import { useEffect, useMemo, useRef, useState } from 'react';

import { RantClient } from '../packages/api/src/index';
import type {
  MediaProjectSnapshot,
  OutputFormat,
} from '../packages/model/src/index';

export function ProductionMedia({
  client,
  onReturnToShot,
  onRevision,
  projectId,
}: {
  client: RantClient;
  onReturnToShot: (shotId: string) => void;
  onRevision: (revision: number) => void;
  projectId: string;
}) {
  const [media, setMedia] = useState<MediaProjectSnapshot | null>(null);
  const [shotId, setShotId] = useState('');
  const [allowPlaceholders, setAllowPlaceholders] = useState(false);
  const [formats, setFormats] = useState<OutputFormat[]>([
    'landscape',
    'vertical',
  ]);
  const [status, setStatus] = useState('Load preview and export state.');
  const [busy, setBusy] = useState(false);
  const [artifactUrl, setArtifactUrl] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewFormat, setPreviewFormat] = useState<OutputFormat>('landscape');
  const [previewRevision, setPreviewRevision] = useState<number | null>(null);
  const [previewScope, setPreviewScope] = useState<'assembly' | 'shot'>('shot');
  const currentRevision = useRef(0);
  const confirmedLocalRevisions = useRef(new Set<number>());
  const pendingLocalRevisions = useRef(new Set<number>());
  const deferredPendingEvents = useRef(new Set<number>());

  useEffect(
    () => () => {
      if (artifactUrl) URL.revokeObjectURL(artifactUrl);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [artifactUrl, previewUrl],
  );

  useEffect(() => {
    if (!media) return;
    return client.subscribeEvents((event) => {
      if (event.projectId !== projectId) return;
      if (
        event.revision <= currentRevision.current ||
        confirmedLocalRevisions.current.has(event.revision)
      ) {
        return;
      }
      if (pendingLocalRevisions.current.has(event.revision)) {
        deferredPendingEvents.current.add(event.revision);
        return;
      }
      void client.getMedia(projectId).then((next) => {
        if (next.revision <= currentRevision.current) return;
        currentRevision.current = next.revision;
        setMedia((current) =>
          !current || next.revision >= current.revision ? next : current,
        );
        setShotId((current) =>
          next.shots.some((candidate) => candidate.id === current)
            ? current
            : next.shots[0]?.id ?? '',
        );
        setAllowPlaceholders(false);
        setStatus(
          `External change detected at revision ${next.revision}; the previous preview and preflight are stale. Live state refreshed.`,
        );
        onRevision(next.revision);
      });
    });
  }, [client, Boolean(media), onRevision, projectId]);

  async function load() {
    setBusy(true);
    try {
      const next = await client.getMedia(projectId);
      currentRevision.current = next.revision;
      setMedia(next);
      setShotId((current) => current || next.shots[0]?.id || '');
      setStatus(`Preview and preflight loaded at revision ${next.revision}.`);
      onRevision(next.revision);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Media workspace failed');
    } finally {
      setBusy(false);
    }
  }

  const shot = useMemo(
    () => media?.shots.find((candidate) => candidate.id === shotId) ?? null,
    [media, shotId],
  );

  if (!media) {
    return (
      <section className="intake-card">
        <p className="eyebrow">Preview and output</p>
        <h3>Revision-bound media</h3>
        <p>Inspect shots, preflight both formats, then authorize a durable render.</p>
        <button type="button" disabled={busy} onClick={load}>
          Open preview and export
        </button>
        <p role="status">{status}</p>
      </section>
    );
  }

  async function saveOverride(
    format: OutputFormat,
    next: { captionsEnabled: boolean; fit: 'cover' | 'contain' },
  ) {
    if (!shot) return;
    const expectedLocalRevision = media!.revision + 1;
    pendingLocalRevisions.current.add(expectedLocalRevision);
    setBusy(true);
    try {
      const updated = await client.setFormatOverride(projectId, shot.id, {
        ...next,
        expectedRevision: media!.revision,
        format,
      });
      pendingLocalRevisions.current.delete(expectedLocalRevision);
      deferredPendingEvents.current.delete(expectedLocalRevision);
      confirmedLocalRevisions.current.add(updated.revision);
      if (updated.revision >= currentRevision.current) {
        currentRevision.current = updated.revision;
        setMedia(updated);
        setStatus(`${format} settings saved at revision ${updated.revision}.`);
      }
      onRevision(updated.revision);
    } catch (error) {
      pendingLocalRevisions.current.delete(expectedLocalRevision);
      setStatus(error instanceof Error ? error.message : 'Output setting failed');
      if (deferredPendingEvents.current.delete(expectedLocalRevision)) {
        void client.getMedia(projectId).then((next) => {
          if (next.revision <= currentRevision.current) return;
          currentRevision.current = next.revision;
          setMedia(next);
          setShotId((current) =>
            next.shots.some((candidate) => candidate.id === current)
              ? current
              : next.shots[0]?.id ?? '',
          );
          setAllowPlaceholders(false);
          setStatus(
            `External change detected at revision ${next.revision}; the previous preview and preflight are stale. Live state refreshed.`,
          );
          onRevision(next.revision);
        });
      }
    } finally {
      setBusy(false);
    }
  }

  const latestJob = media.jobs[0];

  async function playPreview(scope: 'assembly' | 'shot') {
    if (scope === 'shot' && !shot) return;
    setBusy(true);
    setStatus(`Rendering immutable ${scope} preview…`);
    try {
      const preview = await client.createPreview(projectId, {
        expectedRevision: media!.revision,
        format: previewFormat,
        shotId: scope === 'shot' ? shot!.id : undefined,
      });
      const blob = await client.getPreviewArtifact(projectId, preview.id);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));
      setPreviewRevision(preview.baseRevision);
      setPreviewScope(scope);
      setStatus(
        `${scope === 'shot' ? 'Shot' : 'Assembly'} preview ready from immutable revision ${preview.baseRevision}.`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Preview failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="production-media" aria-labelledby="media-heading">
      <header className="editorial-heading">
        <div>
          <p className="eyebrow">Immutable revision {media.preflight.baseRevision}</p>
          <h3 id="media-heading">Preview, preflight, and render</h3>
        </div>
        <button type="button" disabled={busy} onClick={load}>
          Recheck revision
        </button>
      </header>
      <p role="status" aria-live="polite">
        {status}
      </p>

      <div className="media-preview-grid">
        <div>
          <label>
            Preview format
            <select
              value={previewFormat}
              onChange={(event) => setPreviewFormat(event.target.value as OutputFormat)}
            >
              <option value="landscape">16:9 landscape</option>
              <option value="vertical">9:16 vertical</option>
            </select>
          </label>
          <label>
            Preview shot
            <select value={shotId} onChange={(event) => setShotId(event.target.value)}>
              {media.shots.map((candidate, index) => (
                <option key={candidate.id} value={candidate.id}>
                  Shot {index + 1} · {candidate.theme}
                </option>
              ))}
            </select>
          </label>
          {shot ? (
            <article className="shot-preview" data-missing={!shot.selectedAsset}>
              <strong>
                {shot.selectedAsset ? 'Selected visual preview' : 'MISSING VISUAL'}
              </strong>
              <span>
                Source {shot.startMs}–{shot.endMs} ms
              </span>
              <p>{shot.transcript}</p>
              <button type="button" onClick={() => onReturnToShot(shot.id)}>
                Return to this ledger shot
              </button>
              <button type="button" disabled={busy} onClick={() => void playPreview('shot')}>
                Play selected shot
              </button>
            </article>
          ) : null}
          <button type="button" disabled={busy} onClick={() => void playPreview('assembly')}>
            Play assembled edit
          </button>
          {previewUrl ? (
            <div className="playable-preview">
              <strong>
                {previewScope === 'shot' ? 'Individual shot' : 'Assembled edit'} ·
                revision {previewRevision}
              </strong>
              <video className="render-preview" controls autoPlay src={previewUrl}>
                Revision-bound commentary preview
              </video>
            </div>
          ) : null}
        </div>
        <div className="format-overrides">
          {shot
            ? (['landscape', 'vertical'] as OutputFormat[]).map((format) => {
                const current = shot.overrides[format];
                return (
                  <fieldset key={format}>
                    <legend>
                      {format === 'landscape' ? '16:9 landscape' : '9:16 vertical'}
                    </legend>
                    <label>
                      Fit
                      <select
                        value={current.fit}
                        onChange={(event) =>
                          void saveOverride(format, {
                            captionsEnabled: current.captionsEnabled,
                            fit: event.target.value as 'cover' | 'contain',
                          })
                        }
                      >
                        <option value="cover">Cover</option>
                        <option value="contain">Contain</option>
                      </select>
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={current.captionsEnabled}
                        onChange={(event) =>
                          void saveOverride(format, {
                            captionsEnabled: event.target.checked,
                            fit: current.fit,
                          })
                        }
                      />
                      Captions enabled
                    </label>
                  </fieldset>
                );
              })
            : null}
        </div>
      </div>

      <section className="preflight-panel" aria-labelledby="preflight-heading">
        <h4 id="preflight-heading">Export preflight</h4>
        <p>
          {media.preflight.totalDurationMs} ms ·{' '}
          {media.preflight.incompleteShotIds.length} incomplete shots
        </p>
        {media.preflight.blockers.map((blocker) => (
          <p key={blocker} data-level="blocker">
            Blocked: {blocker}
          </p>
        ))}
        {media.preflight.warnings.map((warning) => (
          <p key={warning} data-level="warning">
            Warning: {warning}
          </p>
        ))}
        <div className="render-format-options">
          {(['landscape', 'vertical'] as OutputFormat[]).map((format) => (
            <label key={format}>
              <input
                type="checkbox"
                checked={formats.includes(format)}
                onChange={(event) =>
                  setFormats((current) =>
                    event.target.checked
                      ? [...current, format]
                      : current.filter((candidate) => candidate !== format),
                  )
                }
              />
              {format === 'landscape' ? 'Render 16:9' : 'Render 9:16'}
            </label>
          ))}
        </div>
        {media.preflight.requiresPlaceholderApproval ? (
          <label>
            <input
              type="checkbox"
              checked={allowPlaceholders}
              onChange={(event) => setAllowPlaceholders(event.target.checked)}
            />
            I authorize unmistakable placeholders for incomplete shots
          </label>
        ) : null}
        <button
          type="button"
          disabled={
            busy ||
            formats.length === 0 ||
            media.preflight.blockers.length > 0 ||
            (media.preflight.requiresPlaceholderApproval && !allowPlaceholders)
          }
          onClick={async () => {
            setBusy(true);
            setStatus('Queueing immutable render…');
            try {
              const queued = await client.createRenderJob(projectId, {
                allowPlaceholders,
                expectedRevision: media.revision,
                formats,
              });
              setStatus(`Render ${queued.id.slice(0, 8)} queued; running locally…`);
              const completed = await client.runRenderJob(projectId, queued.id);
              const next = await client.getMedia(projectId);
              currentRevision.current = next.revision;
              setMedia(next);
              setStatus(
                completed.status === 'succeeded'
                  ? `Render succeeded with ${completed.artifacts.length} artifacts.`
                  : `Render failed: ${completed.errorMessage}`,
              );
              const artifact =
                completed.artifacts.find((candidate) => candidate.format === 'landscape') ??
                completed.artifacts[0];
              if (artifact) {
                const blob = await client.getRenderArtifact(projectId, artifact.id);
                if (artifactUrl) URL.revokeObjectURL(artifactUrl);
                setArtifactUrl(URL.createObjectURL(blob));
              }
            } catch (error) {
              setStatus(error instanceof Error ? error.message : 'Render failed');
            } finally {
              setBusy(false);
            }
          }}
        >
          Render selected formats
        </button>
      </section>

      {artifactUrl ? (
        <video className="render-preview" controls src={artifactUrl}>
          Rendered commentary preview
        </video>
      ) : null}

      <section className="render-jobs" aria-label="Render jobs">
        <h4>Render jobs</h4>
        {media.jobs.map((job) => (
          <article key={job.id}>
            <strong>
              {job.status} · revision {job.baseRevision}
            </strong>
            <span>{job.artifacts.length} artifacts</span>
            {job.errorMessage ? <p>{job.errorMessage}</p> : null}
            {['queued', 'waiting'].includes(job.status) ? (
              <button
                type="button"
                onClick={async () => {
                  await client.cancelRenderJob(projectId, job.id);
                  await load();
                }}
              >
                Cancel render
              </button>
            ) : null}
            {['failed', 'canceled', 'waiting'].includes(job.status) ? (
              <button
                type="button"
                onClick={async () => {
                  await client.retryRenderJob(projectId, job.id, {
                    expectedProjectRevision: media.revision,
                  });
                  await load();
                }}
              >
                Retry render
              </button>
            ) : null}
          </article>
        ))}
        {!latestJob ? <p>No render jobs yet.</p> : null}
      </section>
    </section>
  );
}
