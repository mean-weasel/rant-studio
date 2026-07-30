export type ShotPlanningMode = 'discover' | 'outline';

export type ShotPlanningBrief = {
  direction: string;
  id: string;
  title: string;
};

export type ShotPlanningRequest = {
  briefs: ShotPlanningBrief[];
  direction: string;
  maxDurationMs: number | null;
  maxWordsPerShot: number | null;
  minDurationMs: number | null;
  mode: ShotPlanningMode;
  targetShotCount: number;
};

export type ShotProposalDraft = {
  briefId?: string;
  endWordOrdinal: number;
  id?: string;
  proposalSummary?: string;
  rationale: string;
  shotCountRationale?: string;
  startWordOrdinal: number;
  theme: string;
  visualBrief?: string;
};

export type StagedShotProposal = Omit<
  ShotProposalDraft,
  'id' | 'proposalSummary' | 'shotCountRationale'
> & {
  id: string;
};

export type ShotProposalSubmission = {
  shotCountRationale?: string;
  shots: ShotProposalDraft[];
  summary?: string;
};

export type RevisionBoundShotProposalSubmission = ShotProposalSubmission & {
  baseProjectRevision: number;
  baseTranscriptRevisionId: string;
};

function optionalPositiveInteger(value: unknown, label: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

export function normalizeShotPlanningRequest(
  value: unknown,
): ShotPlanningRequest {
  if (!value || typeof value !== 'object') {
    throw new Error('Shot planning context is required');
  }
  const input = value as Record<string, unknown>;
  const mode = input.mode;
  if (mode !== 'discover' && mode !== 'outline') {
    throw new Error('Planning mode must be discover or outline');
  }
  const targetShotCount = Number(input.targetShotCount);
  if (!Number.isInteger(targetShotCount) || targetShotCount < 1) {
    throw new Error('Target shot count must be a positive integer');
  }
  const direction =
    typeof input.direction === 'string' ? input.direction.trim() : '';
  const briefs = Array.isArray(input.briefs)
    ? input.briefs.map((brief, index) => {
        if (!brief || typeof brief !== 'object') {
          throw new Error(`Outline brief ${index + 1} is invalid`);
        }
        const record = brief as Record<string, unknown>;
        const title =
          typeof record.title === 'string' ? record.title.trim() : '';
        const briefDirection =
          typeof record.direction === 'string' ? record.direction.trim() : '';
        if (!title || !briefDirection) {
          throw new Error(
            `Outline brief ${index + 1} needs a title and direction`,
          );
        }
        return {
          direction: briefDirection,
          id:
            typeof record.id === 'string' && record.id.trim()
              ? record.id.trim()
              : `brief-${index + 1}`,
          title,
        };
      })
    : [];
  if (new Set(briefs.map((brief) => brief.id)).size !== briefs.length) {
    throw new Error('Outline brief IDs must be unique');
  }
  if (mode === 'outline' && !direction && briefs.length === 0) {
    throw new Error('Outline mode needs direction or ordered shot briefs');
  }
  if (mode === 'discover' && briefs.length > 0) {
    throw new Error('Ordered shot briefs are only valid in outline mode');
  }
  const minDurationMs = optionalPositiveInteger(
    input.minDurationMs,
    'Minimum duration',
  );
  const maxDurationMs = optionalPositiveInteger(
    input.maxDurationMs,
    'Maximum duration',
  );
  if (
    minDurationMs !== null &&
    maxDurationMs !== null &&
    minDurationMs > maxDurationMs
  ) {
    throw new Error('Minimum duration cannot exceed maximum duration');
  }
  return {
    briefs,
    direction,
    maxDurationMs,
    maxWordsPerShot: optionalPositiveInteger(
      input.maxWordsPerShot,
      'Maximum words per shot',
    ),
    minDurationMs,
    mode,
    targetShotCount,
  };
}

export function shotPlanningInstruction(
  request: ShotPlanningRequest,
  pacing: string,
): string {
  const target = `${request.targetShotCount} shot${
    request.targetShotCount === 1 ? '' : 's'
  }`;
  if (request.mode === 'outline') {
    return `Map the corrected transcript to the creator's ordered outline. ${target} is the current target. Preserve every word exactly once and explain any count deviation. Pacing: ${pacing}.`;
  }
  return `Discover the transcript's semantic commentary structure. ${target} is a soft target, not an equal partition. Preserve every word exactly once and explain any count deviation. Pacing: ${pacing}.`;
}
