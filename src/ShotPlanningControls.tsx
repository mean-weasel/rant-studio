import { useMemo, useState } from 'react';

import type {
  ShotPlanningBrief,
  ShotPlanningMode,
  ShotPlanningRequest,
} from '../packages/model/src/index.ts';

type Props = {
  disabled: boolean;
  hasRejectedProposal: boolean;
  maxShots: number;
  onQueue: (input: { pacing: string; planning: ShotPlanningRequest }) => void;
};

function optionalInteger(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function outlineBriefs(value: string): ShotPlanningBrief[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const separator = line.includes('|') ? '|' : ':';
      const parts = line.split(separator);
      const title =
        parts.length > 1 ? parts.shift()!.trim() : `Shot ${index + 1}`;
      const direction = parts.length > 0 ? parts.join(separator).trim() : line;
      return { direction, id: `brief-${index + 1}`, title };
    });
}

export function ShotPlanningControls({
  disabled,
  hasRejectedProposal,
  maxShots,
  onQueue,
}: Props) {
  const [mode, setMode] = useState<ShotPlanningMode>('discover');
  const [pacing, setPacing] = useState('Standard');
  const [shotCount, setShotCount] = useState(3);
  const [direction, setDirection] = useState('');
  const [briefText, setBriefText] = useState('');
  const [minDurationSeconds, setMinDurationSeconds] = useState('');
  const [maxDurationSeconds, setMaxDurationSeconds] = useState('');
  const [maxWordsPerShot, setMaxWordsPerShot] = useState('');
  const briefs = useMemo(() => outlineBriefs(briefText), [briefText]);
  const validTarget =
    Number.isInteger(shotCount) && shotCount >= 1 && shotCount <= maxShots;
  const needsOutlineDirection =
    mode === 'outline' && !direction.trim() && briefs.length === 0;

  return (
    <section className="intake-card">
      <div>
        <h3>Agent connection</h3>
        <p>
          The browser queues revision-bound context. An external CLI agent reads
          the full transcript, makes semantic decisions, and submits a staged
          proposal.
        </p>
      </div>

      <fieldset className="pacing-grid">
        <legend>Planning mode</legend>
        <label
          className={
            mode === 'discover' ? 'pacing-card selected' : 'pacing-card'
          }
        >
          <input
            checked={mode === 'discover'}
            name="planning-mode"
            onChange={() => setMode('discover')}
            type="radio"
          />
          <span>
            <strong>Discover structure</strong>
            <small>
              The agent finds the transcript’s natural semantic beats.
            </small>
          </span>
        </label>
        <label
          className={
            mode === 'outline' ? 'pacing-card selected' : 'pacing-card'
          }
        >
          <input
            checked={mode === 'outline'}
            name="planning-mode"
            onChange={() => setMode('outline')}
            type="radio"
          />
          <span>
            <strong>Map to outline</strong>
            <small>
              You supply the intended shots; the agent maps boundaries.
            </small>
          </span>
        </label>
      </fieldset>

      <label style={{ display: 'grid', gap: 5 }}>
        {mode === 'outline' ? 'Outline direction' : 'Optional agent direction'}
        <textarea
          onChange={(event) => setDirection(event.target.value)}
          placeholder={
            mode === 'outline'
              ? 'Example: Open with the misconception, explain the cost, then land the counterpoint.'
              : 'Example: Favor complete rhetorical thoughts over equal timing.'
          }
          rows={3}
          value={direction}
        />
      </label>

      {mode === 'outline' ? (
        <label style={{ display: 'grid', gap: 5 }}>
          Ordered shot briefs (optional, one per line)
          <textarea
            onChange={(event) => setBriefText(event.target.value)}
            placeholder={
              'The premise | Establish the misconception\nThe cost | Show the hidden consequence\nThe turn | Land the counterpoint'
            }
            rows={4}
            value={briefText}
          />
          <small>
            Use “Title | direction”. When briefs are supplied, each maps to one
            chronological shot in this order.
          </small>
        </label>
      ) : null}

      <div className="editorial-inline">
        <label>
          Pacing
          <select
            onChange={(event) => setPacing(event.target.value)}
            value={pacing}
          >
            <option>Relaxed</option>
            <option>Standard</option>
            <option>Punchy</option>
          </select>
        </label>
        <label>
          Starting shots
          <input
            disabled={briefs.length > 0}
            max={Math.max(1, maxShots)}
            min={1}
            onChange={(event) => setShotCount(Number(event.target.value))}
            type="number"
            value={briefs.length > 0 ? briefs.length : shotCount}
          />
          <small>
            {briefs.length > 0
              ? 'Set by the ordered briefs.'
              : 'A soft target; the agent may deviate with an explanation.'}
          </small>
        </label>
      </div>

      <details className="advanced-settings">
        <summary>Advanced constraints</summary>
        <div className="advanced-grid">
          <label>
            Minimum duration (seconds)
            <input
              min={1}
              onChange={(event) => setMinDurationSeconds(event.target.value)}
              type="number"
              value={minDurationSeconds}
            />
          </label>
          <label>
            Maximum duration (seconds)
            <input
              min={1}
              onChange={(event) => setMaxDurationSeconds(event.target.value)}
              type="number"
              value={maxDurationSeconds}
            />
          </label>
          <label>
            Maximum words per shot
            <input
              min={1}
              onChange={(event) => setMaxWordsPerShot(event.target.value)}
              type="number"
              value={maxWordsPerShot}
            />
          </label>
        </div>
      </details>

      {needsOutlineDirection ? (
        <p role="alert">
          Add outline direction or at least one ordered shot brief.
        </p>
      ) : null}
      {briefs.length === 0 && !validTarget ? (
        <p role="alert">Starting shots must be between 1 and {maxShots}.</p>
      ) : null}
      <button
        disabled={
          disabled ||
          needsOutlineDirection ||
          (briefs.length === 0 && !validTarget)
        }
        onClick={() => {
          const targetShotCount = briefs.length || shotCount;
          onQueue({
            pacing,
            planning: {
              briefs: mode === 'outline' ? briefs : [],
              direction: direction.trim(),
              maxDurationMs:
                optionalInteger(maxDurationSeconds) === null
                  ? null
                  : optionalInteger(maxDurationSeconds)! * 1_000,
              maxWordsPerShot: optionalInteger(maxWordsPerShot),
              minDurationMs:
                optionalInteger(minDurationSeconds) === null
                  ? null
                  : optionalInteger(minDurationSeconds)! * 1_000,
              mode,
              targetShotCount,
            },
          });
        }}
        type="button"
      >
        {hasRejectedProposal
          ? 'Queue regenerated external proposal'
          : 'Queue external shot proposal'}
      </button>
    </section>
  );
}
