import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

type Phase = 'transcript' | 'setup' | 'working' | 'proposal' | 'ledger';
type Pacing = 'Relaxed' | 'Standard' | 'Punchy';
type View = 'Edit' | 'Activity' | 'History' | 'Settings';
type OutputFormat = 'landscape' | 'vertical';

type AssetState = {
  count: number;
  selected: string | null;
  uploadedFile?: string;
};

type TaskReceipt = {
  instruction: string;
  shotId: string;
  status: 'running' | 'done';
};

type Shot = {
  id: string;
  source: string;
  duration: string;
  transcript: string;
  theme: string;
  visual: 'selected' | 'candidates' | 'missing';
};

const originalTranscript =
  'The strange thing about subscription fatigue is that every app thinks it’s the exception.';

const shots: Shot[] = [
  {
    id: '01',
    source: '00:00.0–00:12.4',
    duration: '12.4s',
    transcript:
      'The strange thing about subscription fatigue is that every app thinks it is the exception.',
    theme: 'The premise',
    visual: 'selected',
  },
  {
    id: '02',
    source: '00:12.4–00:20.2',
    duration: '7.8s',
    transcript:
      'Every one of them arrives with a tiny promise: this will make your life simpler.',
    theme: 'The promise',
    visual: 'candidates',
  },
  {
    id: '03',
    source: '00:20.2–00:28.9',
    duration: '8.7s',
    transcript:
      'But stack enough tiny conveniences together and suddenly you have another utility bill.',
    theme: 'The accumulation',
    visual: 'missing',
  },
  {
    id: '04',
    source: '00:28.9–00:35.8',
    duration: '6.9s',
    transcript:
      'The price is not just money. It is the low hum of remembering what renews when.',
    theme: 'The hidden cost',
    visual: 'missing',
  },
  {
    id: '05',
    source: '00:35.8–00:42.0',
    duration: '6.2s',
    transcript: 'Maybe the premium feature we actually need is an ending.',
    theme: 'The turn',
    visual: 'candidates',
  },
];

const proposalRows = [
  [
    '1',
    '00:00.0',
    '00:11.8',
    originalTranscript,
    'The premise',
    'Open on the core tension before the examples begin.',
  ],
  [
    '2',
    '00:11.8',
    '00:20.2',
    'Every one of them arrives with a tiny promise: this will make your life simpler.',
    'The promise',
    'Keep the optimistic promise together as one rhetorical beat.',
  ],
  [
    '3',
    '00:20.2',
    '00:28.9',
    'But stack enough tiny conveniences together and suddenly you have another utility bill.',
    'The accumulation',
    'Let the utility-bill comparison land without interruption.',
  ],
  [
    '4',
    '00:28.9',
    '00:35.8',
    'The price is not just money. It is the low hum of remembering what renews when.',
    'The hidden cost',
    'Shift from money to attention with a deliberate new shot.',
  ],
  [
    '5',
    '00:35.8',
    '00:42.0',
    'Maybe the premium feature we actually need is an ending.',
    'The turn',
    'Hold the closing line as its own clean payoff.',
  ],
];

function createInitialAssetStates(): Record<string, AssetState> {
  return {
    '01': { count: 3, selected: 'stacked-subscriptions.jpg' },
    '02': { count: 2, selected: null },
    '03': { count: 0, selected: null },
    '04': { count: 0, selected: null },
    '05': { count: 2, selected: null },
  };
}

export function App() {
  const [phase, setPhase] = useState<Phase>('transcript');
  const [view, setView] = useState<View>('Edit');
  const [pacing, setPacing] = useState<Pacing>('Standard');
  const [attempt, setAttempt] = useState(1);
  const [correcting, setCorrecting] = useState(false);
  const [corrected, setCorrected] = useState(false);
  const [transcript, setTranscript] = useState(originalTranscript);
  const [draftCorrection, setDraftCorrection] = useState(originalTranscript);
  const [firstBoundary, setFirstBoundary] = useState('00:11.8');
  const [acceptedShots, setAcceptedShots] = useState<Shot[]>(shots);
  const [selectedShot, setSelectedShot] = useState('01');
  const [assetStates, setAssetStates] = useState<Record<string, AssetState>>(
    createInitialAssetStates,
  );
  const [agentInstruction, setAgentInstruction] = useState('');
  const [taskReceipt, setTaskReceipt] = useState<TaskReceipt | null>(null);
  const [lastAgentShot, setLastAgentShot] = useState<string | null>(null);
  const [uploadShot, setUploadShot] = useState<string | null>(null);
  const [inspectedAsset, setInspectedAsset] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('landscape');
  const [formatFit, setFormatFit] = useState<
    Record<OutputFormat, 'cover' | 'contain'>
  >({
    landscape: 'cover',
    vertical: 'cover',
  });
  const [exportStage, setExportStage] = useState<
    'preflight' | 'confirm' | 'done' | null
  >(null);
  const [placeholderConfirmed, setPlaceholderConfirmed] = useState(false);
  const [historyItems, setHistoryItems] = useState<string[]>([]);
  const [proposalReceipt, setProposalReceipt] = useState<Pacing | null>(null);
  const [includeVisualBriefs, setIncludeVisualBriefs] = useState(false);
  const agentTaskTimer = useRef<number | null>(null);
  const hasRenderedWorkspace = useRef(false);

  useEffect(() => {
    if (phase !== 'working') return;
    const timer = window.setTimeout(() => setPhase('proposal'), 520);
    return () => window.clearTimeout(timer);
  }, [phase, attempt]);

  useEffect(
    () => () => {
      if (agentTaskTimer.current !== null)
        window.clearTimeout(agentTaskTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!hasRenderedWorkspace.current) {
      hasRenderedWorkspace.current = true;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const heading = document.querySelector<HTMLElement>(
        '[data-workspace-heading]',
      );
      if (!heading) return;
      heading.focus({ preventScroll: true });
      heading.scrollIntoView({ block: 'start' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [phase, view]);

  const selected = useMemo(
    () =>
      acceptedShots.find((shot) => shot.id === selectedShot) ??
      acceptedShots[0],
    [acceptedShots, selectedShot],
  );

  function beginProposal() {
    setAttempt(1);
    setFirstBoundary('00:11.8');
    setPhase('setup');
  }

  function askAgent() {
    setPhase('working');
  }

  function regenerate() {
    setAttempt((current) => current + 1);
    setPhase('proposal');
  }

  function saveCorrection() {
    setTranscript(draftCorrection);
    setCorrected(true);
    setCorrecting(false);
  }

  function selectCandidate(shotId: string, assetName: string) {
    setAssetStates((current) => ({
      ...current,
      [shotId]: { ...current[shotId], selected: assetName },
    }));
    setHistoryItems((current) => [
      `Visual selected for Shot ${shotId}`,
      ...current.filter(
        (item) => item !== `Visual selected for Shot ${shotId}`,
      ),
    ]);
  }

  function addUploadedCandidate(shotId: string) {
    setAssetStates((current) => ({
      ...current,
      [shotId]: {
        ...current[shotId],
        count: current[shotId].count + 1,
        uploadedFile: 'demo-still.png',
      },
    }));
    setUploadShot(null);
  }

  function sendAgentInstruction() {
    const instruction = agentInstruction.trim();
    if (!instruction) return;
    const targetShot = selectedShot;
    setTaskReceipt({ instruction, shotId: targetShot, status: 'running' });
    agentTaskTimer.current = window.setTimeout(() => {
      setAssetStates((current) => ({
        ...current,
        [targetShot]: {
          ...current[targetShot],
          count: current[targetShot].count + 1,
        },
      }));
      setLastAgentShot(targetShot);
      setTaskReceipt({ instruction, shotId: targetShot, status: 'done' });
      setAgentInstruction('');
      agentTaskTimer.current = null;
    }, 520);
  }

  function acceptProposal() {
    const firstDuration = firstBoundary === '00:12.4' ? '12.4s' : '11.8s';
    const secondDuration = firstBoundary === '00:12.4' ? '7.8s' : '8.4s';
    setAcceptedShots(
      shots.map((shot, index) => {
        if (index === 0) {
          return {
            ...shot,
            duration: firstDuration,
            source: `00:00.0–${firstBoundary}`,
            transcript,
          };
        }
        if (index === 1) {
          return {
            ...shot,
            duration: secondDuration,
            source: `${firstBoundary}–00:20.2`,
          };
        }
        return shot;
      }),
    );
    setPhase('ledger');
    setProposalReceipt(pacing);
    setHistoryItems(['Shot plan accepted']);
  }

  function resetDemo() {
    if (agentTaskTimer.current !== null) {
      window.clearTimeout(agentTaskTimer.current);
      agentTaskTimer.current = null;
    }
    setPhase('transcript');
    setView('Edit');
    setPacing('Standard');
    setAttempt(1);
    setCorrecting(false);
    setCorrected(false);
    setTranscript(originalTranscript);
    setDraftCorrection(originalTranscript);
    setFirstBoundary('00:11.8');
    setAcceptedShots(shots);
    setSelectedShot('01');
    setAssetStates(createInitialAssetStates());
    setAgentInstruction('');
    setTaskReceipt(null);
    setLastAgentShot(null);
    setUploadShot(null);
    setInspectedAsset(null);
    setPreviewOpen(false);
    setOutputFormat('landscape');
    setFormatFit({ landscape: 'cover', vertical: 'cover' });
    setExportStage(null);
    setPlaceholderConfirmed(false);
    setHistoryItems([]);
    setProposalReceipt(null);
    setIncludeVisualBriefs(false);
  }

  const missingShotIds = Object.entries(assetStates)
    .filter(([, state]) => !state.selected)
    .map(([id]) => id);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#workspace">
        Skip to workspace
      </a>
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            R
          </div>
          <div>
            <h1>Rant Studio</h1>
            <p>Commentary video workbench</p>
          </div>
        </div>
        <nav aria-label="Project views">
          {['Edit', 'Activity', 'History', 'Settings'].map((item) => (
            <button
              aria-current={item === view ? 'page' : undefined}
              className={item === view ? 'nav-item active' : 'nav-item'}
              key={item}
              onClick={() => setView(item as View)}
              type="button"
            >
              {item}
            </button>
          ))}
        </nav>
        <div className="topbar-actions">
          <div className="agent-status">
            <span aria-hidden="true" className="status-dot" />
            <span>
              <strong>Codex</strong>
              <small>session attached</small>
            </span>
          </div>
          <button className="reset-button" onClick={resetDemo} type="button">
            Reset demo
          </button>
          <button
            className="quiet-button"
            disabled={phase !== 'ledger'}
            onClick={() => setPreviewOpen(true)}
            type="button"
          >
            Open preview
          </button>
          <button
            className="primary-button"
            disabled={phase !== 'ledger'}
            onClick={() => setExportStage('preflight')}
            type="button"
          >
            Export
          </button>
        </div>
      </header>

      <nav
        aria-label="Mobile project controls"
        className="mobile-project-controls"
      >
        <div className="mobile-view-links">
          {(['Edit', 'Activity', 'History', 'Settings'] as View[]).map(
            (item) => (
              <button
                aria-current={item === view ? 'page' : undefined}
                className={item === view ? 'nav-item active' : 'nav-item'}
                key={item}
                onClick={() => setView(item)}
                type="button"
              >
                {item}
              </button>
            ),
          )}
        </div>
        <div className="mobile-project-actions">
          <span className="mobile-agent-label">
            <i aria-hidden="true" className="status-dot" />
            Codex attached
          </span>
          <button className="reset-button" onClick={resetDemo} type="button">
            Reset demo
          </button>
          <button
            disabled={phase !== 'ledger'}
            onClick={() => setPreviewOpen(true)}
            type="button"
          >
            Preview
          </button>
        </div>
      </nav>

      <main id="workspace">
        <section className="project-bar" aria-label="Project summary">
          <div>
            <span className="eyebrow">PROJECT 01</span>
            <h2>Subscription Fatigue</h2>
          </div>
          <div className="project-stats">
            <span>Source audio · 00:42</span>
            <span>OpenAI transcript</span>
            <span>Saved locally</span>
          </div>
        </section>

        {view === 'Edit' && phase === 'transcript' && (
          <TranscriptWorkspace
            corrected={corrected}
            correcting={correcting}
            draftCorrection={draftCorrection}
            onBeginCorrection={() => setCorrecting(true)}
            onCancelCorrection={() => {
              setDraftCorrection(transcript);
              setCorrecting(false);
            }}
            onDraftCorrection={setDraftCorrection}
            onPropose={beginProposal}
            onSaveCorrection={saveCorrection}
            transcript={transcript}
          />
        )}

        {view === 'Edit' && phase === 'setup' && (
          <ProposalSetup
            includeVisualBriefs={includeVisualBriefs}
            onCancel={() => setPhase('transcript')}
            onIncludeVisualBriefs={setIncludeVisualBriefs}
            onPacing={setPacing}
            onSubmit={askAgent}
            pacing={pacing}
          />
        )}

        {view === 'Edit' && phase === 'working' && (
          <section className="center-stage" aria-live="polite">
            <div className="agent-orbit" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <span className="eyebrow">ATTACHED AGENT WORKING</span>
            <h2 data-workspace-heading tabIndex={-1}>
              Codex is reading 84 timestamped words
            </h2>
            <p>
              Applying {pacing.toLowerCase()} pacing while preserving every word
              in chronological order.
            </p>
            <div className="progress-track">
              <div />
            </div>
          </section>
        )}

        {view === 'Edit' && phase === 'proposal' && (
          <ProposalReview
            attempt={attempt}
            firstBoundary={firstBoundary}
            firstTranscript={transcript}
            includeVisualBriefs={includeVisualBriefs}
            onAccept={acceptProposal}
            onBoundary={() => setFirstBoundary('00:12.4')}
            onRegenerate={regenerate}
            onReject={() => setPhase('transcript')}
            pacing={pacing}
          />
        )}

        {view === 'Edit' && phase === 'ledger' && (
          <Ledger
            agentInstruction={agentInstruction}
            assetStates={assetStates}
            lastAgentShot={lastAgentShot}
            onAskAgent={(shotId) => {
              setSelectedShot(shotId);
              setAgentInstruction(
                `Find visual candidates for Shot ${shotId} without selecting one.`,
              );
            }}
            onAgentInstruction={setAgentInstruction}
            onInspectAsset={setInspectedAsset}
            onOpenUpload={setUploadShot}
            onSelectCandidate={selectCandidate}
            onSendAgent={sendAgentInstruction}
            onSelect={setSelectedShot}
            selected={selected}
            selectedShot={selectedShot}
            shots={acceptedShots}
            pacing={pacing}
            taskReceipt={taskReceipt}
          />
        )}
        {view === 'Activity' && (
          <ActivityView
            proposalPacing={proposalReceipt}
            receipt={taskReceipt}
          />
        )}
        {view === 'History' && <HistoryView items={historyItems} />}
        {view === 'Settings' && (
          <SettingsView
            includeVisualBriefs={includeVisualBriefs}
            onIncludeVisualBriefs={setIncludeVisualBriefs}
            pacing={pacing}
          />
        )}
      </main>
      {uploadShot && (
        <UploadCandidateDialog
          onAdd={() => addUploadedCandidate(uploadShot)}
          onClose={() => setUploadShot(null)}
          shotId={uploadShot}
        />
      )}
      {inspectedAsset && (
        <ProvenanceDialog
          assetName={inspectedAsset}
          onClose={() => setInspectedAsset(null)}
        />
      )}
      {previewOpen && (
        <PreviewDialog
          fit={formatFit}
          format={outputFormat}
          onClose={() => setPreviewOpen(false)}
          onFit={(format, fit) =>
            setFormatFit((current) => ({ ...current, [format]: fit }))
          }
          onFormat={setOutputFormat}
        />
      )}
      {exportStage && (
        <ExportDialog
          missingShotIds={missingShotIds}
          onClose={() => {
            setExportStage(null);
            setPlaceholderConfirmed(false);
          }}
          onConfirm={() => setExportStage('confirm')}
          onRender={() => setExportStage('done')}
          onToggleConfirmation={setPlaceholderConfirmed}
          placeholderConfirmed={placeholderConfirmed}
          stage={exportStage}
        />
      )}
    </div>
  );
}

function TranscriptWorkspace(props: {
  corrected: boolean;
  correcting: boolean;
  draftCorrection: string;
  onBeginCorrection: () => void;
  onCancelCorrection: () => void;
  onDraftCorrection: (value: string) => void;
  onPropose: () => void;
  onSaveCorrection: () => void;
  transcript: string;
}) {
  return (
    <div className="transcript-layout">
      <section className="transcript-panel">
        <header className="section-heading">
          <div>
            <span className="eyebrow">SOURCE OF TRUTH</span>
            <h2 data-workspace-heading tabIndex={-1}>
              Untouched transcript
            </h2>
            <p>84 words · word-level timing · one continuous source</p>
          </div>
          <button
            className="quiet-button"
            onClick={props.onBeginCorrection}
            type="button"
          >
            Correct transcript
          </button>
        </header>

        <div className="waveform" aria-label="Source audio waveform">
          {Array.from({ length: 92 }, (_, index) => (
            <i key={index} style={{ height: `${18 + ((index * 17) % 43)}%` }} />
          ))}
          <button
            aria-label="Play source audio"
            className="play-button"
            disabled
            title="Playback is not simulated in this mock-up"
            type="button"
          >
            ▶
          </button>
        </div>

        <div className="transcript-status">
          <span
            className={props.corrected ? 'correction-badge' : 'source-badge'}
          >
            {props.corrected
              ? 'Corrected · timing unchanged'
              : 'Original provider text'}
          </span>
          <span>00:00.0–00:42.0</span>
        </div>

        {props.correcting ? (
          <div className="correction-editor">
            <label htmlFor="correction">Corrected transcript text</label>
            <textarea
              id="correction"
              onChange={(event) => props.onDraftCorrection(event.target.value)}
              rows={4}
              value={props.draftCorrection}
            />
            <p>The audio and original word timestamps will not change.</p>
            <div className="button-row">
              <button
                className="quiet-button"
                onClick={props.onCancelCorrection}
                type="button"
              >
                Cancel
              </button>
              <button
                className="primary-button"
                onClick={props.onSaveCorrection}
                type="button"
              >
                Save correction
              </button>
            </div>
          </div>
        ) : (
          <div className="transcript-copy">
            <p>
              <time>00:00</time>
              <span>{props.transcript}</span>
            </p>
            <p>
              <time>00:12</time>
              <span>
                Every one of them arrives with a tiny promise: this will make
                your life simpler.
              </span>
            </p>
            <p>
              <time>00:20</time>
              <span>
                But stack enough tiny conveniences together and suddenly you
                have another utility bill.
              </span>
            </p>
            <p>
              <time>00:29</time>
              <span>
                The price is not just money. It is the low hum of remembering
                what renews when.
              </span>
            </p>
            <p>
              <time>00:36</time>
              <span>
                Maybe the premium feature we actually need is an ending.
              </span>
            </p>
          </div>
        )}
      </section>

      <aside className="start-card">
        <div className="step-number">01</div>
        <span className="eyebrow">EDITORIAL START</span>
        <h2>Turn narration into shots</h2>
        <p>
          The transcript stays untouched until you ask your attached agent for a
          chronological proposal.
        </p>
        <ul>
          <li>Every spoken word remains covered</li>
          <li>Natural rhetorical beats guide boundaries</li>
          <li>Nothing changes before your approval</li>
        </ul>
        <button
          className="primary-button large"
          onClick={props.onPropose}
          type="button"
        >
          Propose shots
          <span aria-hidden="true">→</span>
        </button>
        <small>Codex session attached and ready</small>
      </aside>
    </div>
  );
}

function ProposalSetup(props: {
  includeVisualBriefs: boolean;
  pacing: Pacing;
  onIncludeVisualBriefs: (include: boolean) => void;
  onPacing: (pacing: Pacing) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <section className="proposal-setup">
      <header>
        <div>
          <span className="eyebrow">NEW AGENT TASK</span>
          <h2 data-workspace-heading tabIndex={-1}>
            Propose chronological shots
          </h2>
          <p>
            The project will not change until you review and accept the result.
          </p>
        </div>
        <button
          aria-label="Close shot proposal setup"
          className="icon-button"
          onClick={props.onCancel}
          type="button"
        >
          ×
        </button>
      </header>

      <fieldset className="pacing-grid">
        <legend>Pacing</legend>
        {[
          ['Relaxed', '10 sec target', '6–15 sec range'],
          ['Standard', '7 sec target', '4–12 sec range'],
          ['Punchy', '4 sec target', '2–7 sec range'],
        ].map(([name, target, range]) => (
          <label
            className={
              props.pacing === name ? 'pacing-card selected' : 'pacing-card'
            }
            key={name}
          >
            <input
              checked={props.pacing === name}
              name="pacing"
              onChange={() => props.onPacing(name as Pacing)}
              type="radio"
            />
            <strong>{name}</strong>
            <span>{target}</span>
            <small>{range}</small>
          </label>
        ))}
      </fieldset>

      <details className="advanced-settings">
        <summary>Advanced constraints</summary>
        <div className="advanced-grid">
          <label>
            Minimum duration
            <input
              defaultValue="4 sec"
              disabled
              title="Planned advanced constraint"
            />
          </label>
          <label>
            Maximum duration
            <input
              defaultValue="12 sec"
              disabled
              title="Planned advanced constraint"
            />
          </label>
          <label>
            Maximum words
            <input
              defaultValue="32"
              disabled
              title="Planned advanced constraint"
            />
          </label>
          <label>
            Approximate shots
            <input
              defaultValue="5"
              disabled
              title="Planned advanced constraint"
            />
          </label>
        </div>
        <p className="prototype-note">
          These controls are shown for planning; this deterministic mock uses
          the selected pacing preset.
        </p>
      </details>

      <label className="switch-row">
        <input
          checked={props.includeVisualBriefs}
          onChange={(event) =>
            props.onIncludeVisualBriefs(event.target.checked)
          }
          type="checkbox"
        />
        <span>
          <strong>Include visual briefs</strong>
          <small>
            Off by default. Add a visual-intent suggestion to each proposed
            shot.
          </small>
        </span>
      </label>

      <footer>
        <div className="agent-assignment">
          <span className="status-dot" />
          <span>
            <small>ASSIGNED TO</small>
            <strong>Codex · attached</strong>
          </span>
        </div>
        <button className="quiet-button" onClick={props.onCancel} type="button">
          Cancel
        </button>
        <button
          className="primary-button"
          onClick={props.onSubmit}
          type="button"
        >
          Ask attached agent
        </button>
      </footer>
    </section>
  );
}

function ProposalReview(props: {
  attempt: number;
  firstBoundary: string;
  firstTranscript: string;
  includeVisualBriefs: boolean;
  pacing: Pacing;
  onAccept: () => void;
  onBoundary: () => void;
  onRegenerate: () => void;
  onReject: () => void;
}) {
  return (
    <section className="proposal-review">
      <header className="review-header">
        <div>
          <span className="eyebrow">AGENT RESULT · READY FOR REVIEW</span>
          <h2 data-workspace-heading tabIndex={-1}>
            Five chronological shots
          </h2>
          <p>
            Attempt {props.attempt} · {props.pacing} pacing
          </p>
        </div>
        <div className="staged-badge">
          <span aria-hidden="true">◇</span>
          <span>
            <strong>Staged proposal · project unchanged</strong>
            <small>84 of 84 words covered · no overlap · chronological</small>
          </span>
        </div>
      </header>

      <div className="proposal-table">
        <div className="proposal-table-head">
          <span>Proposed shot</span>
          <span>Source timing</span>
          <span>Transcript chunk</span>
          <span>Theme and rationale</span>
        </div>
        {proposalRows.map(
          (
            [id, originalStart, originalEnd, transcriptChunk, theme, reason],
            index,
          ) => {
            const start = index === 1 ? props.firstBoundary : originalStart;
            const end = index === 0 ? props.firstBoundary : originalEnd;
            const visibleTranscript =
              index === 0 ? props.firstTranscript : transcriptChunk;
            return (
              <article
                className={
                  index === 0 ? 'proposal-row highlighted' : 'proposal-row'
                }
                key={id}
              >
                <div className="proposal-index">
                  <span>{id.padStart(2, '0')}</span>
                  <small>
                    {index === 0 ? 'Boundary adjusted' : 'Agent proposed'}
                  </small>
                </div>
                <div className="time-range">
                  <label>
                    Start
                    <input
                      aria-label={`Shot ${id} start time`}
                      readOnly
                      value={start}
                    />
                  </label>
                  <span>→</span>
                  <label>
                    End
                    <input
                      aria-label={`Shot ${id} end time`}
                      readOnly
                      value={end}
                    />
                  </label>
                  {index === 0 && (
                    <button
                      aria-label="Nudge first boundary later"
                      className="nudge-button"
                      onClick={props.onBoundary}
                      type="button"
                    >
                      +0.6s
                    </button>
                  )}
                </div>
                <div
                  aria-label={`Transcript chunk for Shot ${id}`}
                  className="proposal-transcript"
                  data-testid={`proposal-transcript-${id.padStart(2, '0')}`}
                  tabIndex={visibleTranscript.length > 180 ? 0 : undefined}
                >
                  <p>{visibleTranscript}</p>
                </div>
                <div className="proposal-reason">
                  <strong>{theme}</strong>
                  <p>{reason}</p>
                  {props.includeVisualBriefs && (
                    <small className="proposal-visual-brief">
                      Visual brief · Seek one simple, legible metaphor for this
                      beat.
                    </small>
                  )}
                </div>
              </article>
            );
          },
        )}
      </div>

      <footer className="review-actions">
        <button className="danger-quiet" onClick={props.onReject} type="button">
          Reject proposal
        </button>
        <button
          className="quiet-button"
          onClick={props.onRegenerate}
          type="button"
        >
          Regenerate proposal
        </button>
        <div className="review-summary">
          <span>5 shots</span>
          <span>00:42 total</span>
          <span>Checkpoint created on accept</span>
        </div>
        <button
          className="primary-button large"
          onClick={props.onAccept}
          type="button"
        >
          Accept 5 shots
          <span aria-hidden="true">→</span>
        </button>
      </footer>
    </section>
  );
}

function Ledger(props: {
  shots: Shot[];
  pacing: Pacing;
  selected: Shot;
  selectedShot: string;
  onSelect: (id: string) => void;
  assetStates: Record<string, AssetState>;
  agentInstruction: string;
  lastAgentShot: string | null;
  onAgentInstruction: (value: string) => void;
  onInspectAsset: (assetName: string) => void;
  onAskAgent: (shotId: string) => void;
  onOpenUpload: (shotId: string) => void;
  onSelectCandidate: (shotId: string, assetName: string) => void;
  onSendAgent: () => void;
  taskReceipt: TaskReceipt | null;
}) {
  const [dockCollapsed, setDockCollapsed] = useState(
    () => window.matchMedia('(max-width: 760px)').matches,
  );

  return (
    <section className="ledger-workspace">
      <header className="ledger-heading">
        <div>
          <span className="eyebrow">EDIT SEQUENCE · CHECKPOINT 01</span>
          <h2 data-workspace-heading tabIndex={-1}>
            Shot Ledger
          </h2>
          <p>5 shots · 00:42</p>
        </div>
        <div className="ledger-controls">
          <span>{props.pacing} pacing</span>
          <span>16:9 captions off</span>
          <span>9:16 captions on</span>
          <button
            className="quiet-button"
            disabled
            title="Undo is planned for the production implementation"
            type="button"
          >
            Undo
          </button>
        </div>
      </header>

      <div className="ledger-list">
        {props.shots.map((shot) => (
          <article
            className={
              props.selectedShot === shot.id ? 'shot-row selected' : 'shot-row'
            }
            data-testid={`shot-${shot.id}`}
            key={shot.id}
          >
            <section className="narration-cell">
              <header>
                <button
                  aria-label={`Select Shot ${shot.id}`}
                  className="shot-selector"
                  onClick={() => props.onSelect(shot.id)}
                  type="button"
                >
                  <span>Shot {shot.id}</span>
                  <small>
                    {props.selectedShot === shot.id ? 'Selected' : 'Select'}
                  </small>
                </button>
                <span>{shot.source}</span>
                <span>{shot.duration}</span>
                <button
                  aria-label={`Play Shot ${shot.id}`}
                  className="mini-play"
                  disabled
                  title="Playback is not simulated in this mock-up"
                  type="button"
                >
                  ▶
                </button>
              </header>
              <div className="mini-waveform" aria-hidden="true">
                {Array.from({ length: 34 }, (_, index) => (
                  <i
                    key={index}
                    style={{ height: `${22 + ((index * 23) % 58)}%` }}
                  />
                ))}
              </div>
              <p
                aria-label={`Transcript for Shot ${shot.id}`}
                className="shot-transcript"
                data-testid={`shot-transcript-${shot.id}`}
                tabIndex={shot.transcript.length > 180 ? 0 : undefined}
              >
                {shot.transcript}
              </p>
              <footer>
                <span>{shot.theme}</span>
                <button
                  disabled
                  title="Planned editorial control"
                  type="button"
                >
                  Split
                </button>
                <button
                  disabled
                  title="Planned editorial control"
                  type="button"
                >
                  Trim
                </button>
                <button
                  disabled
                  title="Planned editorial control"
                  type="button"
                >
                  Move
                </button>
              </footer>
            </section>
            <VisualCell
              agentJustAttached={props.lastAgentShot === shot.id}
              onAskAgent={props.onAskAgent}
              onInspectAsset={props.onInspectAsset}
              onOpenUpload={props.onOpenUpload}
              onSelectCandidate={props.onSelectCandidate}
              shot={shot}
              state={props.assetStates[shot.id]}
            />
          </article>
        ))}
      </div>

      <aside
        className={dockCollapsed ? 'command-dock collapsed' : 'command-dock'}
        aria-label="Agent command dock"
      >
        <div className="dock-meta">
          <span className="target-chip" data-testid="agent-target-chip">
            Shot {props.selected.id}
          </span>
          <button
            disabled
            title="One attached session in this mock-up"
            type="button"
          >
            Codex · attached
          </button>
          <button
            disabled
            title="Candidate search is the modeled dock action"
            type="button"
          >
            Find candidates
          </button>
          <button
            aria-expanded={!dockCollapsed}
            aria-label={
              dockCollapsed ? 'Expand agent dock' : 'Collapse agent dock'
            }
            className="dock-collapse-toggle"
            onClick={() => setDockCollapsed((current) => !current)}
            type="button"
          >
            {dockCollapsed ? 'Expand' : 'Collapse'}
          </button>
          <span className="dock-ready">
            <i />
            Ready
          </span>
        </div>
        <div className="dock-composer">
          <label className="sr-only" htmlFor="agent-instruction">
            Instruction for attached agent
          </label>
          <input
            id="agent-instruction"
            onChange={(event) => props.onAgentInstruction(event.target.value)}
            placeholder={`Ask Codex about Shot ${props.selected.id}…`}
            value={props.agentInstruction}
          />
          <button
            aria-label="Send instruction"
            className="primary-button"
            disabled={
              !props.agentInstruction.trim() ||
              props.taskReceipt?.status === 'running'
            }
            onClick={props.onSendAgent}
            type="button"
          >
            Send ↗
          </button>
        </div>
        <p aria-live="polite" className="dock-task-status" role="status">
          {props.taskReceipt?.status === 'running'
            ? `Codex is working on Shot ${props.taskReceipt.shotId}`
            : props.taskReceipt?.status === 'done'
              ? `Codex added a candidate to Shot ${props.taskReceipt.shotId}; selection unchanged`
              : ''}
        </p>
      </aside>
    </section>
  );
}

function VisualCell({
  shot,
  state,
  agentJustAttached,
  onAskAgent,
  onInspectAsset,
  onOpenUpload,
  onSelectCandidate,
}: {
  shot: Shot;
  state: AssetState;
  agentJustAttached: boolean;
  onAskAgent: (shotId: string) => void;
  onInspectAsset: (assetName: string) => void;
  onOpenUpload: (shotId: string) => void;
  onSelectCandidate: (shotId: string, assetName: string) => void;
}) {
  if (state.selected) {
    return (
      <section className="visual-cell">
        <header>
          <span>CANDIDATES · {state.count}</span>
          <span className="selected-status">
            ✓ Selected by you · agent cannot replace
          </span>
          <button
            disabled
            title="Per-format crop editing is planned"
            type="button"
          >
            16:9 crop · 9:16 crop
          </button>
        </header>
        <div className="candidate-grid">
          {Array.from({ length: state.count }, (_, index) =>
            index === 0 ? (
              <button
                aria-label={`Active candidate for Shot ${shot.id}`}
                className="candidate active"
                data-candidate-asset
                key="active"
                type="button"
              >
                <span className="candidate-art art-one" />
                <strong>ACTIVE</strong>
              </button>
            ) : (
              <button
                aria-label={`Select alternate agent candidate ${index + 1} for Shot ${shot.id}`}
                className="candidate"
                data-candidate-asset
                key={`alternate-${index}`}
                onClick={() =>
                  onSelectCandidate(
                    shot.id,
                    `agent-alternate-${index + 1}-shot-${shot.id}.jpg`,
                  )
                }
                type="button"
              >
                <span
                  className={`candidate-art ${index % 2 === 0 ? 'art-three' : 'art-two'}`}
                />
                <small>Agent {index + 1}</small>
              </button>
            ),
          )}
          <button
            aria-label={`Upload files for Shot ${shot.id}`}
            className="candidate upload"
            onClick={() => onOpenUpload(shot.id)}
            type="button"
          >
            <span>＋</span>
            Upload candidate
          </button>
        </div>
        <footer>
          <button onClick={() => onInspectAsset(state.selected!)} type="button">
            Inspect
          </button>
          <button
            disabled
            title="Choose another visible candidate to replace the selection"
            type="button"
          >
            Replace
          </button>
          <span>Provenance verified</span>
        </footer>
      </section>
    );
  }

  if (state.count > 0) {
    return (
      <section className="visual-cell">
        <header>
          <span>
            {state.count} {state.count === 1 ? 'candidate' : 'candidates'} ·
            none selected
          </span>
          <span className="recommendation-status">
            {agentJustAttached
              ? 'Candidate attached · awaiting your selection'
              : 'Agent recommendation'}
          </span>
        </header>
        <div className="candidate-grid two">
          {Array.from({ length: state.count }, (_, index) => {
            const assetName =
              index === 0
                ? (state.uploadedFile ?? `uploaded-shot-${shot.id}.jpg`)
                : `agent-pick-${index + 1}-shot-${shot.id}.jpg`;
            return (
              <button
                aria-label={
                  index === 0
                    ? `Select uploaded candidate for Shot ${shot.id}`
                    : `Select agent candidate ${index + 1} for Shot ${shot.id}`
                }
                className="candidate"
                data-candidate-asset
                key={assetName}
                onClick={() => onSelectCandidate(shot.id, assetName)}
                type="button"
              >
                <span
                  className={`candidate-art ${index % 2 === 0 ? 'art-three' : 'art-four'}`}
                />
                <small>
                  {index === 0 && state.uploadedFile
                    ? 'Uploaded by you'
                    : `Candidate ${index + 1}`}
                </small>
              </button>
            );
          })}
          <button
            aria-label={`Upload files for Shot ${shot.id}`}
            className="candidate upload"
            onClick={() => onOpenUpload(shot.id)}
            type="button"
          >
            <span>＋</span>
            Upload candidate
          </button>
        </div>
        <footer>
          <span>No active visual · only you can select</span>
          {state.uploadedFile && (
            <button
              aria-label={`Inspect ${state.uploadedFile}`}
              onClick={() => onInspectAsset(state.uploadedFile!)}
              type="button"
            >
              Inspect {state.uploadedFile}
            </button>
          )}
        </footer>
      </section>
    );
  }

  return (
    <section className="visual-cell missing">
      <header>
        <span>NO VISUAL SELECTED</span>
        <span className="warning-status">Draft placeholder</span>
      </header>
      <div className="missing-actions">
        <button
          aria-label={`Upload files for Shot ${shot.id}`}
          className="quiet-button"
          onClick={() => onOpenUpload(shot.id)}
          type="button"
        >
          Upload files
        </button>
        <button
          aria-label={`Ask agent for candidates for Shot ${shot.id}`}
          className="quiet-button"
          onClick={() => onAskAgent(shot.id)}
          type="button"
        >
          Ask agent for candidates
        </button>
        <button
          disabled
          title="Shot notes are planned for implementation"
          className="text-button"
          type="button"
        >
          Add note
        </button>
      </div>
      <p>
        Preview will use a clearly marked placeholder until you select a visual.
      </p>
    </section>
  );
}

function ActivityView({
  receipt,
  proposalPacing,
}: {
  receipt: TaskReceipt | null;
  proposalPacing: Pacing | null;
}) {
  const receiptCount = (receipt ? 1 : 0) + (proposalPacing ? 1 : 0);
  return (
    <section className="secondary-view">
      <header className="secondary-view-heading">
        <div>
          <span className="eyebrow">DURABLE TASK RECEIPTS</span>
          <h2 data-workspace-heading tabIndex={-1}>
            Agent activity
          </h2>
          <p>Compact project evidence, not a duplicate of the external chat.</p>
        </div>
        <span className="view-count">
          {receiptCount > 0
            ? `${receiptCount} ${receiptCount === 1 ? 'receipt' : 'receipts'}`
            : 'No receipts yet'}
        </span>
      </header>
      {proposalPacing && (
        <article className="receipt-card proposal-receipt">
          <div className="receipt-icon" aria-hidden="true">
            C
          </div>
          <div className="receipt-main">
            <header>
              <strong>Codex · Shot proposal</strong>
              <span className="receipt-done">Accepted by you</span>
            </header>
            <blockquote>
              Propose chronological shots with {proposalPacing.toLowerCase()}{' '}
              pacing.
            </blockquote>
            <div className="receipt-result">
              <strong>
                5 staged shots accepted · project checkpoint created
              </strong>
              <span>Complete transcript coverage · no overlap</span>
            </div>
          </div>
          <dl>
            <div>
              <dt>Target</dt>
              <dd>Transcript</dd>
            </div>
            <div>
              <dt>Authority</dt>
              <dd>Proposal only</dd>
            </div>
          </dl>
        </article>
      )}
      {receipt ? (
        <article className="receipt-card">
          <div className="receipt-icon" aria-hidden="true">
            C
          </div>
          <div className="receipt-main">
            <header>
              <strong>Codex · Shot {receipt.shotId}</strong>
              <span
                className={
                  receipt.status === 'done' ? 'receipt-done' : 'receipt-running'
                }
              >
                {receipt.status === 'done' ? 'Completed' : 'Running'}
              </span>
            </header>
            <blockquote>{receipt.instruction}</blockquote>
            {receipt.status === 'done' && (
              <div className="receipt-result">
                <strong>Added 1 candidate · selection unchanged</strong>
                <span>archive-subscription-grid.jpg</span>
                <span>Provenance recorded</span>
              </div>
            )}
          </div>
          <dl>
            <div>
              <dt>Target</dt>
              <dd>Shot {receipt.shotId}</dd>
            </div>
            <div>
              <dt>Authority</dt>
              <dd>Additive only</dd>
            </div>
            <div>
              <dt>Task</dt>
              <dd>task_0042</dd>
            </div>
          </dl>
        </article>
      ) : !proposalPacing ? (
        <div className="empty-view">
          <span aria-hidden="true">◇</span>
          <h3>No agent work yet</h3>
          <p>
            Send an instruction from the Shot Ledger to create the first durable
            receipt.
          </p>
        </div>
      ) : null}
    </section>
  );
}

function HistoryView({ items }: { items: string[] }) {
  const entries =
    items.length > 0
      ? items
      : ['Project created', 'Transcript imported', 'Source audio preserved'];
  return (
    <section className="secondary-view">
      <header className="secondary-view-heading">
        <div>
          <span className="eyebrow">LINEAR EDIT HISTORY</span>
          <h2 data-workspace-heading tabIndex={-1}>
            Project history
          </h2>
          <p>Every approved editorial change is attributed and reversible.</p>
        </div>
        <button
          className="quiet-button"
          disabled
          title="Named checkpoints are planned for implementation"
          type="button"
        >
          Name checkpoint
        </button>
      </header>
      <div className="history-timeline">
        {entries.map((entry, index) => (
          <article key={entry}>
            <span className="history-node" />
            <div>
              <strong>{entry}</strong>
              <p>
                {entry === 'Shot plan accepted'
                  ? 'Checkpoint 01 · 5 chronological shots · by you'
                  : entry.startsWith('Visual selected')
                    ? 'Human editorial selection · agent authority unchanged'
                    : 'Local project event'}
              </p>
            </div>
            <time>{index === 0 ? 'just now' : `${index + 1} min ago`}</time>
          </article>
        ))}
      </div>
    </section>
  );
}

function SettingsView({
  includeVisualBriefs,
  onIncludeVisualBriefs,
  pacing,
}: {
  includeVisualBriefs: boolean;
  onIncludeVisualBriefs: (include: boolean) => void;
  pacing: Pacing;
}) {
  return (
    <section className="secondary-view">
      <header className="secondary-view-heading">
        <div>
          <span className="eyebrow">PROJECT DEFAULTS</span>
          <h2 data-workspace-heading tabIndex={-1}>
            Settings
          </h2>
          <p>
            Prototype controls mirror the approved local-first product
            boundaries.
          </p>
        </div>
      </header>
      <div className="settings-grid">
        <article>
          <span className="eyebrow">SHOT PROPOSALS</span>
          <h3>{pacing} pacing</h3>
          <p>
            {pacing === 'Relaxed'
              ? '10 second target · 6–15 second soft range'
              : pacing === 'Punchy'
                ? '4 second target · 2–7 second soft range'
                : '7 second target · 4–12 second soft range'}
          </p>
          <label className="switch-row">
            <input
              checked={includeVisualBriefs}
              onChange={(event) => onIncludeVisualBriefs(event.target.checked)}
              type="checkbox"
            />
            <span>
              <strong>Include visual briefs</strong>
              <small>Off by default</small>
            </span>
          </label>
        </article>
        <article>
          <span className="eyebrow">OUTPUTS</span>
          <h3>Two shared formats</h3>
          <p>16:9 captions off · 9:16 captions on</p>
        </article>
        <article>
          <span className="eyebrow">AGENT AUTHORITY</span>
          <h3>Additive writes only</h3>
          <p>Selections and editorial changes always require you.</p>
        </article>
      </div>
    </section>
  );
}

function DialogFrame({
  children,
  onClose,
  closeLabel,
  dialogLabel,
}: {
  children: ReactNode;
  onClose: () => void;
  closeLabel: string;
  dialogLabel: string;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const background = [
      document.querySelector<HTMLElement>('.topbar'),
      document.querySelector<HTMLElement>('.mobile-project-controls'),
      document.querySelector<HTMLElement>('#workspace'),
    ].filter((element): element is HTMLElement => Boolean(element));
    const previousOverflow = document.body.style.overflow;
    background.forEach((element) => element.setAttribute('inert', ''));
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();

    return () => {
      background.forEach((element) => element.removeAttribute('inert'));
      document.body.style.overflow = previousOverflow;
      returnFocus?.focus();
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="dialog-backdrop">
      <section
        aria-label={dialogLabel}
        aria-modal="true"
        className="dialog-card"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <button
          aria-label={closeLabel}
          className="dialog-close"
          onClick={onClose}
          ref={closeRef}
          type="button"
        >
          ×
        </button>
        {children}
      </section>
    </div>
  );
}

function UploadCandidateDialog({
  shotId,
  onAdd,
  onClose,
}: {
  shotId: string;
  onAdd: () => void;
  onClose: () => void;
}) {
  return (
    <DialogFrame
      closeLabel="Close candidate upload"
      dialogLabel="Attach a candidate"
      onClose={onClose}
    >
      <span className="eyebrow">SHOT {shotId} · HUMAN ASSET INTAKE</span>
      <h2>Attach a candidate</h2>
      <p className="dialog-lede">
        This prototype simulates copying one local file into managed project
        media.
      </p>
      <div className="demo-file">
        <span className="file-art" aria-hidden="true" />
        <div>
          <strong>demo-still.png</strong>
          <small>1920×1080 · PNG · 1.8 MB</small>
        </div>
        <span>Checksum ready</span>
      </div>
      <footer className="dialog-actions">
        <button className="quiet-button" onClick={onClose} type="button">
          Cancel
        </button>
        <button className="primary-button" onClick={onAdd} type="button">
          Add demo-still.png
        </button>
      </footer>
    </DialogFrame>
  );
}

function ProvenanceDialog({
  assetName,
  onClose,
}: {
  assetName: string;
  onClose: () => void;
}) {
  return (
    <DialogFrame
      closeLabel="Close asset provenance"
      dialogLabel="Asset provenance"
      onClose={onClose}
    >
      <span className="eyebrow">ASSET RECEIPT</span>
      <h2>Asset provenance</h2>
      <div className="provenance-grid">
        <div>
          <span>File</span>
          <strong>{assetName}</strong>
        </div>
        <div>
          <span>Origin</span>
          <strong>Human browser upload</strong>
        </div>
        <div>
          <span>Added to</span>
          <strong>Managed local media</strong>
        </div>
        <div>
          <span>Checksum</span>
          <strong className="mono">8b91…c42e</strong>
        </div>
      </div>
    </DialogFrame>
  );
}

function PreviewDialog({
  format,
  fit,
  onClose,
  onFit,
  onFormat,
}: {
  format: OutputFormat;
  fit: Record<OutputFormat, 'cover' | 'contain'>;
  onClose: () => void;
  onFit: (format: OutputFormat, fit: 'cover' | 'contain') => void;
  onFormat: (format: OutputFormat) => void;
}) {
  const isLandscape = format === 'landscape';
  return (
    <DialogFrame
      closeLabel="Close preview"
      dialogLabel="Assembled preview"
      onClose={onClose}
    >
      <header className="preview-header">
        <div>
          <span className="eyebrow">ON-DEMAND PLAYER</span>
          <h2>Assembled preview</h2>
          <p>
            {isLandscape
              ? 'Landscape · Captions off'
              : 'Vertical · Captions on'}
          </p>
        </div>
        <div className="format-switch">
          <button
            aria-label="Landscape 16:9"
            aria-pressed={isLandscape}
            onClick={() => onFormat('landscape')}
            type="button"
          >
            16:9
          </button>
          <button
            aria-label="Vertical 9:16"
            aria-pressed={!isLandscape}
            onClick={() => onFormat('vertical')}
            type="button"
          >
            9:16
          </button>
        </div>
      </header>
      <div
        className={
          isLandscape ? 'preview-frame landscape' : 'preview-frame vertical'
        }
      >
        <div className={`preview-art ${fit[format]}`}>
          <span>Subscription fatigue</span>
          {!isLandscape && <strong>every app thinks it’s the exception</strong>}
        </div>
        <button
          aria-label="Play assembled preview"
          className="preview-play"
          disabled
          title="Playback is not simulated in this mock-up"
          type="button"
        >
          ▶
        </button>
      </div>
      <div className="preview-controls">
        <span>00:12 / 00:42 · Shot 02</span>
        <div>
          <button
            aria-label={`Cover ${format} visual`}
            aria-pressed={fit[format] === 'cover'}
            onClick={() => onFit(format, 'cover')}
            type="button"
          >
            Cover
          </button>
          <button
            aria-label={`Contain ${format} visual`}
            aria-pressed={fit[format] === 'contain'}
            onClick={() => onFit(format, 'contain')}
            type="button"
          >
            Contain
          </button>
        </div>
      </div>
    </DialogFrame>
  );
}

function formatShotList(ids: string[]) {
  if (ids.length === 0) return 'No shots';
  if (ids.length === 1) return `Shot ${ids[0]}`;
  if (ids.length === 2) return `Shots ${ids[0]} and ${ids[1]}`;
  return `Shots ${ids.slice(0, -1).join(', ')}, and ${ids.at(-1)}`;
}

function numberWord(value: number) {
  return (
    ['zero', 'one', 'two', 'three', 'four', 'five'][value] ?? String(value)
  );
}

function ExportDialog({
  stage,
  missingShotIds,
  placeholderConfirmed,
  onClose,
  onConfirm,
  onRender,
  onToggleConfirmation,
}: {
  stage: 'preflight' | 'confirm' | 'done';
  missingShotIds: string[];
  placeholderConfirmed: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onRender: () => void;
  onToggleConfirmation: (checked: boolean) => void;
}) {
  const missingCount = missingShotIds.length;
  const missingList = formatShotList(missingShotIds);
  const missingWord = numberWord(missingCount);
  return (
    <DialogFrame
      closeLabel="Close export"
      dialogLabel={
        stage === 'preflight'
          ? 'Export preflight'
          : stage === 'confirm'
            ? 'Confirm placeholder export'
            : 'Two mock renders are ready'
      }
      onClose={onClose}
    >
      {stage === 'preflight' && (
        <>
          <span className="eyebrow">DETERMINISTIC CHECK</span>
          <h2>Export preflight</h2>
          <div className="preflight-summary">
            <strong>{missingCount} shots need visuals</strong>
            <p>{missingList} will use unmistakable placeholder frames.</p>
          </div>
          <ul className="preflight-list">
            <li className="pass">Source audio readable · 00:42</li>
            <li className="pass">Five valid shot ranges · no overlap</li>
            <li className="pass">16:9 and 9:16 framing configured</li>
            <li className="warning">
              Missing visuals require your confirmation
            </li>
          </ul>
          <footer className="dialog-actions">
            <button className="quiet-button" onClick={onClose} type="button">
              Return to edit
            </button>
            <button
              className="primary-button"
              onClick={onConfirm}
              type="button"
            >
              Export anyway
            </button>
          </footer>
        </>
      )}
      {stage === 'confirm' && (
        <>
          <span className="eyebrow">HUMAN AUTHORITY GATE</span>
          <h2>Confirm placeholder export</h2>
          <p className="dialog-lede">
            This action is intentionally explicit. An agent cannot approve
            incomplete final output.
          </p>
          <label className="confirmation-check">
            <input
              checked={placeholderConfirmed}
              onChange={(event) => onToggleConfirmation(event.target.checked)}
              type="checkbox"
            />
            <span>
              <strong>Include clearly marked placeholder frames</strong>
              <small>
                I understand that {missingWord}{' '}
                {missingCount === 1 ? 'shot is' : 'shots are'} visually
                incomplete.
              </small>
            </span>
          </label>
          <footer className="dialog-actions">
            <button className="quiet-button" onClick={onClose} type="button">
              Cancel
            </button>
            <button
              className="primary-button"
              disabled={!placeholderConfirmed}
              onClick={onRender}
              type="button"
            >
              Render simulated MP4s
            </button>
          </footer>
        </>
      )}
      {stage === 'done' && (
        <div className="render-success">
          <span aria-hidden="true">✓</span>
          <span className="eyebrow">SIMULATED RENDER COMPLETE</span>
          <h2>Two mock renders are ready</h2>
          <p>
            No media was rendered; this validates the final product interaction.
          </p>
          <div>
            <article>
              <strong>subscription-fatigue-16x9.mp4</strong>
              <small>1920×1080 · captions off</small>
            </article>
            <article>
              <strong>subscription-fatigue-9x16.mp4</strong>
              <small>1080×1920 · captions on</small>
            </article>
          </div>
        </div>
      )}
    </DialogFrame>
  );
}
