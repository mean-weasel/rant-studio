import { useEffect, useState } from 'react';

import { RantClient } from '../packages/api/src/index';
import {
  shotPlanningInstruction,
  type EditorialProjectSnapshot,
  type ShotPlanningRequest,
} from '../packages/model/src/index';
import { ProductionLedger } from './ProductionLedger';
import { ShotPlanningControls } from './ShotPlanningControls';
import { TranscriptNavigator } from './TranscriptNavigator';

type Props = {
  client: RantClient;
  projectId: string;
  onRevision: (revision: number) => void;
};

export function ProductionEditorial({ client, projectId, onRevision }: Props) {
  const [editorial, setEditorial] = useState<EditorialProjectSnapshot | null>(
    null,
  );
  const [selectedWord, setSelectedWord] = useState('');
  const [replacement, setReplacement] = useState('');
  const [status, setStatus] = useState(
    'Load the editorial workspace to begin.',
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!editorial) return;
    return client.subscribeEvents((event) => {
      if (event.projectId !== projectId) return;
      void client.getEditorial(projectId).then((next) => {
        setEditorial((current) =>
          !current || next.revision >= current.revision ? next : current,
        );
        setSelectedWord((current) =>
          next.effectiveTranscript.words.some((word) => word.id === current)
            ? current
            : (next.effectiveTranscript.words[0]?.id ?? ''),
        );
        onRevision(next.revision);
      });
    });
  }, [client, Boolean(editorial), onRevision, projectId]);

  async function load() {
    setBusy(true);
    try {
      const next = await client.getEditorial(projectId);
      setEditorial(next);
      setSelectedWord(next.effectiveTranscript.words[0]?.id ?? '');
      setStatus(`Editorial revision ${next.revision} loaded.`);
      onRevision(next.revision);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : 'Editorial load failed',
      );
    } finally {
      setBusy(false);
    }
  }

  async function correct() {
    if (!editorial || !selectedWord || !replacement.trim()) return;
    setBusy(true);
    setStatus('Saving correction…');
    try {
      const next = await client.correctTranscript(projectId, {
        expectedRevision: editorial.revision,
        replacementText: replacement,
        wordId: selectedWord,
      });
      setEditorial(next);
      setReplacement('');
      setStatus(
        `Correction saved at revision ${next.revision}. Raw text preserved.`,
      );
      onRevision(next.revision);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Correction failed');
    } finally {
      setBusy(false);
    }
  }

  async function askAgent(input: {
    pacing: string;
    planning: ShotPlanningRequest;
  }) {
    if (!editorial) return;
    setBusy(true);
    setStatus('Agent task queued…');
    try {
      const task = await client.createProposalTask(projectId, {
        constraints: { planning: input.planning },
        expectedRevision: editorial.revision,
        instruction: shotPlanningInstruction(input.planning, input.pacing),
        pacing: input.pacing,
      });
      setStatus(
        `External task ${task.id} queued. An attached CLI agent must claim and submit it.`,
      );
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : 'Agent proposal failed',
      );
    } finally {
      setBusy(false);
    }
  }

  async function replaceProposal(
    proposal: EditorialProjectSnapshot['proposals'][number],
    shots: EditorialProjectSnapshot['proposals'][number]['shots'],
  ) {
    setBusy(true);
    try {
      const next = await client.adjustShotProposal(projectId, proposal.id, {
        shots,
      });
      setEditorial(next);
      setStatus('Shared boundary updated; exact coverage revalidated.');
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : 'Boundary update failed',
      );
    } finally {
      setBusy(false);
    }
  }

  const readyProposal = editorial?.proposals.find(
    (proposal) => proposal.status === 'ready',
  );
  const readyTask = editorial?.tasks.find(
    (task) => task.id === readyProposal?.taskId,
  );

  if (!editorial) {
    return (
      <section className="intake-card editorial-launch">
        <p className="eyebrow">Next · Human + agent</p>
        <h2>Organize transcript into shots</h2>
        <p>
          Corrections and agent proposals stay staged until a human accepts
          them.
        </p>
        <button type="button" disabled={busy} onClick={load}>
          Open editorial workspace
        </button>
        <p role="status">{status}</p>
      </section>
    );
  }

  return (
    <section
      className="editorial-workspace"
      aria-labelledby="editorial-heading"
    >
      <header className="editorial-heading">
        <div>
          <p className="eyebrow">
            Revision {editorial.revision} · staged workflow
          </p>
          <h2 id="editorial-heading">Transcript and shot proposal</h2>
        </div>
        <button type="button" disabled={busy} onClick={load}>
          Refresh
        </button>
      </header>
      <p className="intake-status" role="status" aria-live="polite">
        {status}
      </p>

      <div className="editorial-transcripts">
        <article>
          <h3>Raw provider transcript</h3>
          <TranscriptNavigator
            label="Raw provider transcript"
            words={editorial.rawTranscript.words}
          />
        </article>
        <article>
          <h3>Corrected working transcript</h3>
          <TranscriptNavigator
            label="Corrected working transcript"
            onSelectWord={setSelectedWord}
            selectedWordId={selectedWord}
            words={editorial.effectiveTranscript.words}
          />
        </article>
      </div>

      <section className="intake-card">
        <h3>Correct a timestamped word</h3>
        <div className="editorial-inline">
          <div>
            <label htmlFor="correction-word">Word</label>
            {editorial.effectiveTranscript.words.length <= 80 ? (
              <select
                id="correction-word"
                value={selectedWord}
                onChange={(event) => setSelectedWord(event.target.value)}
              >
                {editorial.effectiveTranscript.words.map((word) => (
                  <option key={word.id} value={word.id}>
                    {word.ordinal + 1}. {word.text} ({word.startMs}–{word.endMs}{' '}
                    ms)
                  </option>
                ))}
              </select>
            ) : (
              <output id="correction-word">
                Selected word{' '}
                {(editorial.effectiveTranscript.words.find(
                  (word) => word.id === selectedWord,
                )?.ordinal ?? 0) + 1}
              </output>
            )}
          </div>
          <label>
            Replacement
            <input
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={busy || !replacement.trim()}
            onClick={correct}
          >
            Save correction
          </button>
        </div>
      </section>

      <ShotPlanningControls
        disabled={busy}
        hasRejectedProposal={editorial.proposals.some(
          (proposal) => proposal.status === 'rejected',
        )}
        maxShots={editorial.effectiveTranscript.words.length}
        onQueue={(input) => void askAgent(input)}
      />

      {readyProposal ? (
        <section className="proposal-review" aria-labelledby="proposal-heading">
          <header>
            <div>
              <p className="eyebrow">Agent result · ready for review</p>
              <h3 id="proposal-heading">
                {readyProposal.shots.length} chronological shots ·{' '}
                {readyProposal.pacing}
              </h3>
              <p>
                {readyTask?.planning?.mode === 'outline'
                  ? 'Mapped to creator outline'
                  : 'Agent-discovered structure'}
                {' · '}task {readyProposal.taskId}
              </p>
            </div>
            <strong>Human approval required</strong>
          </header>
          {readyProposal.summary || readyProposal.shotCountRationale ? (
            <aside className="intake-card">
              {readyProposal.summary ? <p>{readyProposal.summary}</p> : null}
              {readyProposal.shotCountRationale ? (
                <p>
                  <strong>Shot-count decision:</strong>{' '}
                  {readyProposal.shotCountRationale}
                </p>
              ) : null}
            </aside>
          ) : null}
          <div className="proposal-grid proposal-grid-head" aria-hidden="true">
            <span>Shot</span>
            <span>Transcript chunk</span>
            <span>Theme and rationale</span>
          </div>
          {readyProposal.shots.map((shot, index) => {
            const words = editorial.effectiveTranscript.words.slice(
              shot.startWordOrdinal,
              shot.endWordOrdinal + 1,
            );
            return (
              <article
                className="proposal-grid"
                data-proposal-shot-id={shot.id}
                key={shot.id}
              >
                <div>
                  <strong>Shot {index + 1}</strong>
                  <small>{shot.id}</small>
                  <small>
                    {words[0]?.startMs}–{words.at(-1)?.endMs} ms
                  </small>
                </div>
                <div className="proposal-chunk" tabIndex={0}>
                  {words.map((word) => word.text).join(' ')}
                </div>
                <div>
                  <strong>{shot.theme}</strong>
                  <p>{shot.rationale}</p>
                  {shot.visualBrief ? (
                    <p>
                      <strong>Visual idea:</strong> {shot.visualBrief}
                    </p>
                  ) : null}
                  {index < readyProposal.shots.length - 1 ? (
                    <button
                      type="button"
                      disabled={
                        busy ||
                        readyProposal.shots[index + 1]!.endWordOrdinal ===
                          readyProposal.shots[index + 1]!.startWordOrdinal
                      }
                      onClick={() => {
                        const shots = structuredClone(readyProposal.shots);
                        shots[index]!.endWordOrdinal += 1;
                        shots[index + 1]!.startWordOrdinal += 1;
                        void replaceProposal(readyProposal, shots);
                      }}
                    >
                      Move boundary later
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
          <footer>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const next = await client.rejectShotProposal(
                    projectId,
                    readyProposal.id,
                  );
                  setEditorial(next);
                  setStatus(
                    'Proposal rejected. Accepted shots remain unchanged.',
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Reject proposal
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const next = await client.acceptShotProposal(
                    projectId,
                    readyProposal.id,
                    {
                      expectedRevision: editorial.revision,
                    },
                  );
                  setEditorial(next);
                  onRevision(next.revision);
                  setStatus(`Proposal accepted at revision ${next.revision}.`);
                } catch (error) {
                  setStatus(
                    error instanceof Error
                      ? error.message
                      : 'Acceptance failed',
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Accept shots
            </button>
          </footer>
        </section>
      ) : null}

      {editorial.shots.length > 0 ? (
        <>
          <section className="intake-card">
            <p className="eyebrow">Accepted shot ledger</p>
            <h3>{editorial.shots.length} stable shots</h3>
          </section>
          <ProductionLedger
            client={client}
            projectId={projectId}
            onRevision={onRevision}
          />
        </>
      ) : null}
    </section>
  );
}
