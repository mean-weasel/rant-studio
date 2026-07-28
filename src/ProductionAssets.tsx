import { useEffect, useState } from 'react';

import { RantClient } from '../packages/api/src/index';
import type {
  ActivitySnapshot,
  AgentTaskStatus,
  AssetProjectSnapshot,
} from '../packages/model/src/index';

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function visualMimeType(file: File): 'image/png' | 'video/mp4' {
  return file.type === 'video/mp4' || file.name.toLowerCase().endsWith('.mp4')
    ? 'video/mp4'
    : 'image/png';
}

export function ProductionAssets({
  client,
  projectId,
  onRevision,
}: {
  client: RantClient;
  projectId: string;
  onRevision: (revision: number) => void;
}) {
  const [assets, setAssets] = useState<AssetProjectSnapshot | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [status, setStatus] = useState('Load visual candidates.');
  const [busy, setBusy] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [activity, setActivity] = useState<ActivitySnapshot | null>(null);
  const [activityFilter, setActivityFilter] = useState<AgentTaskStatus | ''>('');

  useEffect(() => {
    if (!assets) return;
    return client.subscribeEvents((event) => {
      if (event.projectId !== projectId) return;
      void Promise.all([
        client.getAssets(projectId),
        client.getActivity(projectId, {
          status: activityFilter || undefined,
        }),
      ]).then(([next, nextActivity]) => {
        setAssets((current) =>
          !current || next.revision >= current.revision ? next : current,
        );
        setActivity(nextActivity);
        setTargets((current) =>
          current.filter((id) => next.shots.some((shot) => shot.id === id)),
        );
        onRevision(next.revision);
      });
    });
  }, [activityFilter, Boolean(assets), client, onRevision, projectId]);

  async function load() {
    setBusy(true);
    try {
      const next = await client.getAssets(projectId);
      setAssets(next);
      setTargets((current) =>
        current.length ? current.filter((id) => next.shots.some((shot) => shot.id === id)) : [next.shots[0]?.id ?? ''].filter(Boolean),
      );
      setStatus(`Visual workspace loaded at revision ${next.revision}.`);
      onRevision(next.revision);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Visual workspace failed');
    } finally {
      setBusy(false);
    }
  }

  if (!assets) {
    return (
      <section className="intake-card">
        <p className="eyebrow">Visual collaboration</p>
        <h3>Candidate assets</h3>
        <p>Humans and CLI agents share candidates; only humans select the active visual.</p>
        <button type="button" disabled={busy} onClick={load}>
          Open visual workspace
        </button>
        <p role="status">{status}</p>
      </section>
    );
  }

  return (
    <section className="production-assets" aria-labelledby="assets-heading">
      <header className="editorial-heading">
        <div>
          <p className="eyebrow">Revision {assets.revision}</p>
          <h3 id="assets-heading">Candidate assets</h3>
        </div>
        <button type="button" disabled={busy} onClick={load}>
          Refresh candidates
        </button>
      </header>
      <p className="intake-status" role="status" aria-live="polite">
        {status}
      </p>
      <div className="asset-upload-panel">
        <fieldset>
          <legend>Explicit shot targets</legend>
          {assets.shots.map((shot, index) => (
            <label key={shot.id}>
              <input
                type="checkbox"
                checked={targets.includes(shot.id)}
                onChange={(event) =>
                  setTargets((current) =>
                    event.target.checked
                      ? [...current, shot.id]
                      : current.filter((id) => id !== shot.id),
                  )
                }
              />
              Shot {index + 1} · {shot.id.slice(0, 8)}
            </label>
          ))}
        </fieldset>
        <label>
          Visual candidate (PNG or MP4)
          <input
            type="file"
            accept=".png,.mp4,image/png,video/mp4"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </label>
        <button
          type="button"
          disabled={busy || !file || targets.length === 0}
          onClick={async () => {
            if (!file) return;
            setBusy(true);
            try {
              const next = await client.uploadVisualCandidate(projectId, {
                bytesBase64: base64(new Uint8Array(await file.arrayBuffer())),
                expectedRevision: assets.revision,
                mimeType: visualMimeType(file),
                originalName: file.name,
                shotIds: targets,
              });
              setAssets(next);
              setStatus(
                `Candidate attached to ${targets.length} shot${targets.length === 1 ? '' : 's'}.`,
              );
              onRevision(next.revision);
            } catch (error) {
              setStatus(error instanceof Error ? error.message : 'Candidate upload failed');
            } finally {
              setBusy(false);
            }
          }}
        >
          Upload to selected shots
        </button>
      </div>
      <section className="agent-command-dock" aria-labelledby="agent-dock-heading">
        <div>
          <p className="eyebrow">External agent command</p>
          <h4 id="agent-dock-heading">Explicit targets · {targets.length} selected</h4>
          <p>
            Dispatch creates durable work for a scoped CLI agent. It does not silently
            start an embedded model.
          </p>
        </div>
        <div className="target-chips" aria-label="Agent task targets">
          {targets.map((target) => {
            const index = assets.shots.findIndex((shot) => shot.id === target);
            return <span key={target}>Shot {index + 1} · {target.slice(0, 8)}</span>;
          })}
        </div>
        <label>
          Agent instruction
          <textarea
            rows={3}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={busy || !instruction.trim() || targets.length === 0}
          onClick={async () => {
            setBusy(true);
            try {
              const task = await client.createAssetTask(projectId, {
                expectedRevision: assets.revision,
                instruction,
                shotIds: targets,
              });
              setInstruction('');
              setStatus(`Agent task ${task.id.slice(0, 8)} queued for ${targets.length} shots.`);
              setActivity(await client.getActivity(projectId));
            } catch (error) {
              setStatus(error instanceof Error ? error.message : 'Task dispatch failed');
            } finally {
              setBusy(false);
            }
          }}
        >
          Dispatch task to CLI agent
        </button>
      </section>
      <div className="asset-shot-list">
        {assets.shots.map((shot, index) => (
          <article key={shot.id}>
            <header>
              <strong>Shot {index + 1}</strong>
              <span>
                {shot.candidates.length} candidate{shot.candidates.length === 1 ? '' : 's'}
              </span>
              <button
                type="button"
                onClick={() => {
                  setTargets([shot.id]);
                  setInstruction(`Find a visual candidate for Shot ${index + 1}.`);
                  setStatus(`Shot ${index + 1} targeted; review the instruction before dispatch.`);
                }}
              >
                Ask agent
              </button>
              {shot.selectedAssetId ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const next = await client.clearVisual(projectId, {
                        expectedRevision: assets.revision,
                        shotId: shot.id,
                      });
                      setAssets(next);
                      setStatus(`Human cleared the visual for Shot ${index + 1}.`);
                      onRevision(next.revision);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Clear selected visual
                </button>
              ) : null}
            </header>
            <div className="candidate-tray" tabIndex={0}>
              {shot.candidates.map((assetId) => {
                const asset = assets.assets.find((candidate) => candidate.id === assetId);
                const recommendations = shot.recommendations.filter(
                  (recommendation) => recommendation.assetId === assetId,
                );
                return (
                  <div key={assetId} data-selected={shot.selectedAssetId === assetId}>
                    <strong>{assetId.slice(0, 8)}</strong>
                    <small>
                      {asset?.provenance.actorKind} · {asset?.provenance.origin}
                    </small>
                    <code>{asset?.checksum.slice(0, 12)}…</code>
                    {recommendations.map((recommendation) => (
                      <em key={`${recommendation.agentId}-${recommendation.assetId}`}>
                        Agent recommends: {recommendation.reason}
                      </em>
                    ))}
                    <button
                      type="button"
                      disabled={busy || shot.selectedAssetId === assetId}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          const next = await client.selectVisual(projectId, {
                            assetId,
                            expectedRevision: assets.revision,
                            shotId: shot.id,
                          });
                          setAssets(next);
                          setStatus(`Human selected a visual for Shot ${index + 1}.`);
                          onRevision(next.revision);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      {shot.selectedAssetId === assetId ? 'Selected' : 'Use this visual'}
                    </button>
                  </div>
                );
              })}
              {shot.candidates.length === 0 ? <p>No candidates yet.</p> : null}
            </div>
          </article>
        ))}
      </div>
      <section className="activity-panel" aria-labelledby="activity-heading">
        <header>
          <div>
            <p className="eyebrow">Append-only collaboration evidence</p>
            <h4 id="activity-heading">Activity</h4>
          </div>
          <label>
            Filter status
            <select
              value={activityFilter}
              onChange={(event) =>
                setActivityFilter(event.target.value as AgentTaskStatus | '')
              }
            >
              <option value="">All</option>
              {['queued', 'claimed', 'running', 'waiting', 'succeeded', 'failed', 'canceled'].map(
                (value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ),
              )}
            </select>
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={async () =>
              setActivity(
                await client.getActivity(projectId, {
                  status: activityFilter || undefined,
                }),
              )
            }
          >
            Refresh activity
          </button>
        </header>
        {activity ? (
          <div className="activity-rows">
            {activity.tasks.map((task) => (
              <article key={task.id}>
                <strong>{task.status} · {task.kind}</strong>
                <p>{task.instruction}</p>
                <small>
                  Revision {task.baseRevision}
                  {task.resultRevision ? ` → ${task.resultRevision}` : ''} ·{' '}
                  {task.shotIds.length} target{task.shotIds.length === 1 ? '' : 's'}
                </small>
                {task.status === 'failed' || task.status === 'canceled' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await client.retryTask(projectId, task.id, {
                          expectedProjectRevision: assets.revision,
                        });
                        setActivity(await client.getActivity(projectId));
                        setStatus(`Task ${task.id.slice(0, 8)} queued as a retry.`);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Retry task
                  </button>
                ) : null}
                {activity.receipts
                  .filter((receipt) => receipt.taskId === task.id)
                  .map((receipt) => (
                    <blockquote key={receipt.id}>
                      {receipt.result}: {receipt.summary}
                    </blockquote>
                  ))}
              </article>
            ))}
            {activity.tasks.length === 0 ? <p>No activity matches this filter.</p> : null}
          </div>
        ) : (
          <p>Load Activity to inspect tasks and receipts.</p>
        )}
      </section>
    </section>
  );
}
