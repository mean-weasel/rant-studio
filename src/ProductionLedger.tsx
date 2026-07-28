import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { RantClient } from '../packages/api/src/index';
import type {
  ActivitySnapshot,
  AssetProjectSnapshot,
  LedgerProjectSnapshot,
  TranscriptWord,
} from '../packages/model/src/index';
import { ProductionAssets } from './ProductionAssets';
import { ProductionMedia } from './ProductionMedia';

const DESKTOP_ROW_HEIGHT = 176;
const MOBILE_ROW_HEIGHT = 340;
const WINDOW_SIZE = 20;

export function ProductionLedger({
  client,
  projectId,
  onRevision,
}: {
  client: RantClient;
  projectId: string;
  onRevision: (revision: number) => void;
}) {
  const [ledger, setLedger] = useState<LedgerProjectSnapshot | null>(null);
  const [assets, setAssets] = useState<AssetProjectSnapshot | null>(null);
  const [activity, setActivity] = useState<ActivitySnapshot | null>(null);
  const [words, setWords] = useState<TranscriptWord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checkpointName, setCheckpointName] = useState('');
  const [query, setQuery] = useState('');
  const [visualFilter, setVisualFilter] = useState('all');
  const [taskFilter, setTaskFilter] = useState('all');
  const [completionFilter, setCompletionFilter] = useState('all');
  const [windowStart, setWindowStart] = useState(0);
  const [rowHeight, setRowHeight] = useState(DESKTOP_ROW_HEIGHT);
  const [status, setStatus] = useState('Load the accepted Shot Ledger.');
  const [busy, setBusy] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const ledgerWindowRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!ledger) return;
    return client.subscribeEvents((event) => {
      if (event.projectId !== projectId) return;
      const scrollTop = ledgerWindowRef.current?.scrollTop;
      void Promise.all([
        client.getLedger(projectId),
        client.getAssets(projectId),
        client.getActivity(projectId),
        client.getEditorial(projectId),
      ]).then(([next, nextAssets, nextActivity, editorial]) => {
        setLedger((current) =>
          !current || next.revision >= current.revision ? next : current,
        );
        setAssets(nextAssets);
        setActivity(nextActivity);
        setWords(editorial.effectiveTranscript.words);
        setSelectedId((current) =>
          current && next.shots.some((shot) => shot.id === current)
            ? current
            : (next.shots[0]?.id ?? null),
        );
        onRevision(next.revision);
        requestAnimationFrame(() => {
          if (ledgerWindowRef.current && scrollTop !== undefined) {
            ledgerWindowRef.current.scrollTop = scrollTop;
          }
        });
      });
    });
  }, [client, Boolean(ledger), onRevision, projectId]);

  async function load() {
    setBusy(true);
    try {
      const [next, nextAssets, nextActivity, editorial] = await Promise.all([
        client.getLedger(projectId),
        client.getAssets(projectId),
        client.getActivity(projectId),
        client.getEditorial(projectId),
      ]);
      setLedger(next);
      setAssets(nextAssets);
      setActivity(nextActivity);
      setWords(editorial.effectiveTranscript.words);
      setSelectedId((current) => current ?? next.shots[0]?.id ?? null);
      setStatus(`Shot Ledger revision ${next.revision} loaded.`);
      onRevision(next.revision);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Ledger load failed');
    } finally {
      setBusy(false);
    }
  }

  const filteredShots = useMemo(() => {
    if (!ledger) return [];
    const normalizedQuery = query.trim().toLowerCase();
    const activeStatuses = new Set(['queued', 'claimed', 'running', 'waiting']);
    return ledger.shots.filter((shot) => {
      const shotAssets = assets?.shots.find(
        (candidate) => candidate.id === shot.id,
      );
      const hasSelection = Boolean(shotAssets?.selectedAssetId);
      const hasCandidates = Boolean(shotAssets?.candidates.length);
      const hasActiveTask = Boolean(
        activity?.tasks.some(
          (task) =>
            task.shotIds.includes(shot.id) && activeStatuses.has(task.status),
        ),
      );
      const shotWords = words.slice(
        shot.startWordOrdinal,
        shot.endWordOrdinal + 1,
      );
      const timing = `${shotWords[0]?.startMs ?? 0}–${shotWords.at(-1)?.endMs ?? 0}`;
      const haystack = [
        shot.id,
        String(shot.ordinal + 1),
        shot.theme,
        timing,
        shotWords.map((word) => word.text).join(' '),
      ]
        .join(' ')
        .toLowerCase();
      if (normalizedQuery && !haystack.includes(normalizedQuery)) return false;
      if (visualFilter === 'selected' && !hasSelection) return false;
      if (visualFilter === 'candidates' && (!hasCandidates || hasSelection))
        return false;
      if (visualFilter === 'missing' && hasCandidates) return false;
      if (taskFilter === 'active' && !hasActiveTask) return false;
      if (taskFilter === 'none' && hasActiveTask) return false;
      if (completionFilter === 'complete' && !hasSelection) return false;
      if (completionFilter === 'incomplete' && hasSelection) return false;
      return true;
    });
  }, [
    activity,
    assets,
    completionFilter,
    ledger,
    query,
    taskFilter,
    visualFilter,
    words,
  ]);

  const boundedStart = Math.min(
    windowStart,
    Math.max(0, filteredShots.length - WINDOW_SIZE),
  );
  const visibleShots =
    filteredShots.length <= WINDOW_SIZE
      ? filteredShots
      : filteredShots.slice(boundedStart, boundedStart + WINDOW_SIZE);

  function jumpToShot(shotId: string) {
    const index = filteredShots.findIndex((shot) => shot.id === shotId);
    if (index < 0) {
      setStatus('The requested shot is outside the current filters.');
      return;
    }
    const start = Math.min(
      Math.max(0, index - 2),
      Math.max(0, filteredShots.length - WINDOW_SIZE),
    );
    setWindowStart(start);
    if (ledgerWindowRef.current) {
      ledgerWindowRef.current.scrollTop = index * rowHeight;
    }
    requestAnimationFrame(() => rowRefs.current.get(shotId)?.focus());
  }

  async function apply(
    operation: Parameters<RantClient['editLedger']>[1]['operation'],
    message: string,
  ) {
    if (!ledger) return;
    setBusy(true);
    try {
      const next = await client.editLedger(projectId, {
        expectedRevision: ledger.revision,
        operation,
      });
      setLedger(next);
      setSelectedId((current) =>
        current && next.shots.some((shot) => shot.id === current)
          ? current
          : (next.shots[0]?.id ?? null),
      );
      setStatus(`${message} Revision ${next.revision}.`);
      onRevision(next.revision);
      requestAnimationFrame(() => {
        const target = rowRefs.current.get(
          next.shots.some((shot) => shot.id === selectedId)
            ? (selectedId ?? '')
            : (next.shots[0]?.id ?? ''),
        );
        target?.focus();
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Ledger edit failed');
    } finally {
      setBusy(false);
    }
  }

  if (!ledger) {
    return (
      <section className="intake-card">
        <p className="eyebrow">Accepted edit</p>
        <h3>Production Shot Ledger</h3>
        <p>
          Stable IDs, ancestry, history, checkpoints, and revision-safe edits.
        </p>
        <button type="button" disabled={busy} onClick={load}>
          Open production Shot Ledger
        </button>
        <p role="status">{status}</p>
      </section>
    );
  }

  return (
    <section className="production-ledger" aria-labelledby="ledger-heading">
      <header className="editorial-heading">
        <div>
          <p className="eyebrow">Revision {ledger.revision}</p>
          <h3 id="ledger-heading">Production Shot Ledger</h3>
        </div>
        <div>
          <button type="button" disabled={busy} onClick={load}>
            Refresh live state
          </button>
          <button
            type="button"
            disabled={
              busy ||
              ledger.history.filter((item) => item.operation === 'change_shots')
                .length === 0
            }
            onClick={async () => {
              setBusy(true);
              try {
                const next = await client.undoLedger(projectId, {
                  expectedRevision: ledger.revision,
                });
                setLedger(next);
                setStatus(`Undo restored revision ${next.revision}.`);
                onRevision(next.revision);
              } catch (error) {
                setStatus(
                  error instanceof Error ? error.message : 'Undo failed',
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            Undo last ledger edit
          </button>
        </div>
      </header>
      <p className="intake-status" role="status" aria-live="polite">
        {status}
      </p>

      <div className="ledger-checkpoints">
        <label>
          Checkpoint name
          <input
            value={checkpointName}
            onChange={(event) => setCheckpointName(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={busy || !checkpointName.trim()}
          onClick={async () => {
            if (!ledger) return;
            setBusy(true);
            try {
              const checkpoint = await client.createLedgerCheckpoint(
                projectId,
                {
                  expectedRevision: ledger.revision,
                  name: checkpointName,
                },
              );
              setLedger(await client.getLedger(projectId));
              setCheckpointName('');
              setStatus(`Checkpoint “${checkpoint.name}” saved.`);
            } finally {
              setBusy(false);
            }
          }}
        >
          Name checkpoint
        </button>
        {ledger.checkpoints.map((checkpoint) => (
          <button
            type="button"
            key={checkpoint.id}
            disabled={busy}
            onClick={async () => {
              const next = await client.restoreLedgerCheckpoint(
                projectId,
                checkpoint.id,
                { expectedRevision: ledger.revision },
              );
              setLedger(next);
              setStatus(
                `Restored “${checkpoint.name}” at revision ${next.revision}.`,
              );
              onRevision(next.revision);
            }}
          >
            Restore {checkpoint.name}
          </button>
        ))}
      </div>

      <section
        className="ledger-scale-controls"
        aria-labelledby="ledger-filter-heading"
      >
        <div>
          <h4 id="ledger-filter-heading">Find and filter shots</h4>
          <p role="status" aria-live="polite">
            Showing {filteredShots.length} of {ledger.shots.length} shots ·{' '}
            {assets?.shots.filter((shot) => shot.selectedAssetId).length ?? 0}{' '}
            complete ·{' '}
            {activity?.tasks.filter((task) =>
              ['queued', 'claimed', 'running', 'waiting'].includes(task.status),
            ).length ?? 0}{' '}
            active tasks
          </p>
        </div>
        <label>
          Search shots
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setWindowStart(0);
              if (ledgerWindowRef.current)
                ledgerWindowRef.current.scrollTop = 0;
            }}
            placeholder="ID, timing, transcript, or theme"
          />
        </label>
        <label>
          Visual state
          <select
            value={visualFilter}
            onChange={(event) => {
              setVisualFilter(event.target.value);
              setWindowStart(0);
            }}
          >
            <option value="all">All visuals</option>
            <option value="selected">Selected</option>
            <option value="candidates">Candidates only</option>
            <option value="missing">Missing</option>
          </select>
        </label>
        <label>
          Task state
          <select
            value={taskFilter}
            onChange={(event) => {
              setTaskFilter(event.target.value);
              setWindowStart(0);
            }}
          >
            <option value="all">All tasks</option>
            <option value="active">Active task</option>
            <option value="none">No active task</option>
          </select>
        </label>
        <label>
          Completion
          <select
            value={completionFilter}
            onChange={(event) => {
              setCompletionFilter(event.target.value);
              setWindowStart(0);
            }}
          >
            <option value="all">All completion</option>
            <option value="complete">Complete</option>
            <option value="incomplete">Incomplete</option>
          </select>
        </label>
        <div className="ledger-jump-actions">
          <button
            type="button"
            disabled={!selectedId}
            onClick={() => selectedId && jumpToShot(selectedId)}
          >
            Jump to current shot
          </button>
          <button
            type="button"
            disabled={!assets?.shots.some((shot) => !shot.selectedAssetId)}
            onClick={() => {
              const incomplete = ledger.shots.find(
                (shot) =>
                  !assets?.shots.find((candidate) => candidate.id === shot.id)
                    ?.selectedAssetId,
              );
              if (incomplete) {
                setQuery('');
                setVisualFilter('all');
                setTaskFilter('all');
                setCompletionFilter('all');
                requestAnimationFrame(() => jumpToShot(incomplete.id));
              }
            }}
          >
            Jump to first incomplete
          </button>
        </div>
      </section>

      <ol
        ref={ledgerWindowRef}
        className="production-ledger-rows"
        aria-label="Windowed Shot Ledger"
        data-rendered-shots={visibleShots.length}
        data-total-shots={filteredShots.length}
        onScroll={(event) => {
          if (filteredShots.length <= WINDOW_SIZE) return;
          const nextRowHeight =
            event.currentTarget.clientWidth <= 720
              ? MOBILE_ROW_HEIGHT
              : DESKTOP_ROW_HEIGHT;
          if (nextRowHeight !== rowHeight) setRowHeight(nextRowHeight);
          setWindowStart(
            Math.min(
              Math.max(
                0,
                Math.floor(event.currentTarget.scrollTop / nextRowHeight) - 2,
              ),
              Math.max(0, filteredShots.length - WINDOW_SIZE),
            ),
          );
        }}
        style={
          {
            '--ledger-after-space':
              filteredShots.length > WINDOW_SIZE
                ? `${(filteredShots.length - boundedStart - visibleShots.length) * rowHeight}px`
                : '0px',
            '--ledger-before-space':
              filteredShots.length > WINDOW_SIZE
                ? `${boundedStart * rowHeight}px`
                : '0px',
          } as CSSProperties
        }
      >
        {visibleShots.map((shot) => {
          const index = ledger.shots.findIndex(
            (candidate) => candidate.id === shot.id,
          );
          const filteredIndex = filteredShots.findIndex(
            (candidate) => candidate.id === shot.id,
          );
          const shotWords = words.slice(
            shot.startWordOrdinal,
            shot.endWordOrdinal + 1,
          );
          const shotAssets = assets?.shots.find(
            (candidate) => candidate.id === shot.id,
          );
          return (
            <li
              key={shot.id}
              ref={(node) => {
                if (node) rowRefs.current.set(shot.id, node);
                else rowRefs.current.delete(shot.id);
              }}
              tabIndex={-1}
              aria-posinset={filteredIndex + 1}
              aria-setsize={filteredShots.length}
              data-shot-id={shot.id}
              data-selected={selectedId === shot.id}
              onClick={() => setSelectedId(shot.id)}
            >
              <div>
                <span>Shot {index + 1}</span>
                <code>{shot.id.slice(0, 8)}</code>
              </div>
              <div>
                <strong>{shot.theme}</strong>
                <p>
                  {shotWords[0]?.startMs ?? 0}–{shotWords.at(-1)?.endMs ?? 0} ms
                  · {shotWords.map((word) => word.text).join(' ')}
                </p>
                <small>
                  {shotAssets?.selectedAssetId
                    ? 'Complete · active visual selected'
                    : shotAssets?.candidates.length
                      ? `${shotAssets.candidates.length} candidates · incomplete`
                      : 'Missing visual · incomplete'}
                </small>
              </div>
              <div className="ledger-row-actions">
                <button
                  type="button"
                  disabled={busy || index === 0}
                  onClick={() => {
                    const ids = ledger.shots.map((item) => item.id);
                    [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
                    void apply(
                      { kind: 'reorder', shotIds: ids },
                      'Shot moved.',
                    );
                  }}
                >
                  Move up
                </button>
                <button
                  type="button"
                  disabled={
                    busy || shot.endWordOrdinal === shot.startWordOrdinal
                  }
                  onClick={() =>
                    void apply(
                      {
                        atWordOrdinal:
                          shot.startWordOrdinal +
                          Math.ceil(
                            (shot.endWordOrdinal - shot.startWordOrdinal) / 2,
                          ),
                        kind: 'split',
                        shotId: shot.id,
                      },
                      'Shot split with new ancestry.',
                    )
                  }
                >
                  Split
                </button>
                <button
                  type="button"
                  disabled={
                    busy ||
                    index === ledger.shots.length - 1 ||
                    shot.endWordOrdinal + 1 !==
                      ledger.shots[index + 1]!.startWordOrdinal
                  }
                  onClick={() =>
                    void apply(
                      {
                        kind: 'merge',
                        leftShotId: shot.id,
                        rightShotId: ledger.shots[index + 1]!.id,
                      },
                      'Shots merged with ancestry.',
                    )
                  }
                >
                  Merge next
                </button>
                <button
                  type="button"
                  disabled={busy || ledger.shots.length === 1}
                  onClick={() =>
                    void apply({ kind: 'cut', shotId: shot.id }, 'Shot cut.')
                  }
                >
                  Cut
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      <details>
        <summary>History · {ledger.history.length} events</summary>
        <ol className="ledger-history">
          {ledger.history.map((event) => (
            <li key={`${event.revision}-${event.operation}`}>
              Revision {event.revision} · {event.operation} · {event.actorKind}{' '}
              {event.actorId}
            </li>
          ))}
        </ol>
      </details>
      <ProductionAssets
        client={client}
        projectId={projectId}
        onRevision={onRevision}
      />
      <ProductionMedia
        client={client}
        projectId={projectId}
        onRevision={onRevision}
        onReturnToShot={(returnShotId) => {
          setQuery('');
          setVisualFilter('all');
          setTaskFilter('all');
          setCompletionFilter('all');
          setSelectedId(returnShotId);
          const index = ledger.shots.findIndex(
            (candidate) => candidate.id === returnShotId,
          );
          setWindowStart(
            Math.min(
              Math.max(0, index - 2),
              Math.max(0, ledger.shots.length - WINDOW_SIZE),
            ),
          );
          requestAnimationFrame(() => {
            if (ledgerWindowRef.current) {
              ledgerWindowRef.current.scrollTop = Math.max(
                0,
                index * rowHeight,
              );
            }
            rowRefs.current.get(returnShotId)?.focus();
          });
        }}
      />
    </section>
  );
}
