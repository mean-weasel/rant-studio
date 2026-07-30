import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';

import {
  normalizeShotPlanningRequest,
  type ShotPlanningRequest,
  type ShotProposalDraft,
  type StagedShotProposal,
  type TranscriptWord,
} from '../../../packages/model/src/index.ts';

export class SemanticPlanningError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_PROPOSAL' | 'STALE_PROPOSAL' = 'INVALID_PROPOSAL',
  ) {
    super(message);
  }
}

export type ProposalMetadata = {
  shotCountRationale: string | null;
  summary: string | null;
};

export function normalizeProposalSubmission(input: {
  shotCountRationale?: string;
  shots: ShotProposalDraft[];
  summary?: string;
}): { metadata: ProposalMetadata; shots: StagedShotProposal[] } {
  const summary =
    input.summary ??
    input.shots.find((shot) => shot.proposalSummary)?.proposalSummary;
  const rationale =
    input.shotCountRationale ??
    input.shots.find((shot) => shot.shotCountRationale)?.shotCountRationale;
  return {
    metadata: {
      shotCountRationale: rationale?.trim() || null,
      summary: summary?.trim() || null,
    },
    shots: input.shots.map((shot) => ({
      endWordOrdinal: shot.endWordOrdinal,
      id: shot.id?.trim() || randomUUID(),
      rationale: shot.rationale.trim(),
      startWordOrdinal: shot.startWordOrdinal,
      theme: shot.theme.trim(),
      ...(shot.briefId?.trim() ? { briefId: shot.briefId.trim() } : {}),
      ...(shot.visualBrief?.trim()
        ? { visualBrief: shot.visualBrief.trim() }
        : {}),
    })),
  };
}

export function readProposalOperations(
  database: BetterSqlite3.Database,
  proposalId: string,
): { metadata: ProposalMetadata; shots: StagedShotProposal[] } {
  const rows = database
    .prepare(
      `SELECT operation, payload_json FROM proposal_operations
       WHERE proposal_id = ? ORDER BY ordinal`,
    )
    .all(proposalId) as Array<{ operation: string; payload_json: string }>;
  const metadataRow = rows.find((row) => row.operation === 'set_metadata');
  const parsed = metadataRow
    ? (JSON.parse(metadataRow.payload_json) as Record<string, unknown>)
    : {};
  return {
    metadata: {
      shotCountRationale:
        typeof parsed.shotCountRationale === 'string'
          ? parsed.shotCountRationale
          : null,
      summary: typeof parsed.summary === 'string' ? parsed.summary : null,
    },
    shots: rows
      .filter((row) => row.operation === 'create_shot')
      .map(
        ({ payload_json }) => JSON.parse(payload_json) as StagedShotProposal,
      ),
  };
}

export function writeProposalOperations(input: {
  database: BetterSqlite3.Database;
  metadata: ProposalMetadata;
  proposalId: string;
  replace?: boolean;
  shots: StagedShotProposal[];
}): void {
  if (input.replace) {
    input.database
      .prepare(
        `DELETE FROM proposal_operations
         WHERE proposal_id = ? AND operation = 'create_shot'`,
      )
      .run(input.proposalId);
  }
  const insert = input.database.prepare(
    `INSERT INTO proposal_operations
     (id, proposal_id, ordinal, operation, payload_json)
     VALUES (?, ?, ?, 'create_shot', ?)`,
  );
  input.shots.forEach((shot, ordinal) =>
    insert.run(randomUUID(), input.proposalId, ordinal, JSON.stringify(shot)),
  );
  if (!input.replace) {
    input.database
      .prepare(
        `INSERT INTO proposal_operations
         (id, proposal_id, ordinal, operation, payload_json)
         VALUES (?, ?, -1, 'set_metadata', ?)`,
      )
      .run(randomUUID(), input.proposalId, JSON.stringify(input.metadata));
  }
}

function assertStableShotIdentities(
  prior: StagedShotProposal[],
  next: StagedShotProposal[],
): void {
  if (
    next.length !== prior.length ||
    next.some((shot, index) => shot.id !== prior[index]?.id)
  ) {
    throw new SemanticPlanningError(
      'Boundary adjustments must preserve staged shot identities and order',
    );
  }
}

export function planningFromConstraints(
  constraints: Record<string, unknown>,
): ShotPlanningRequest | null {
  if (!('planning' in constraints)) return null;
  try {
    return normalizeShotPlanningRequest(constraints.planning);
  } catch (error) {
    throw new SemanticPlanningError(
      error instanceof Error ? error.message : 'Invalid shot planning context',
    );
  }
}

export function assertProposalMatchesPlanning(input: {
  database?: BetterSqlite3.Database;
  planning: ShotPlanningRequest | null;
  shotCountRationale: string;
  shots: StagedShotProposal[];
  words: TranscriptWord[];
}): void {
  const { planning, shots, words } = input;
  if (new Set(shots.map((shot) => shot.id)).size !== shots.length) {
    throw new SemanticPlanningError('Proposal shot IDs must be unique');
  }
  if (
    shots.some(
      (shot) =>
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          shot.id,
        ),
    )
  ) {
    throw new SemanticPlanningError('Proposal shot IDs must be UUIDs');
  }
  if (
    input.database &&
    input.database
      .prepare(
        `SELECT 1 FROM shots WHERE id IN (${shots.map(() => '?').join(',')})
         LIMIT 1`,
      )
      .get(...shots.map((shot) => shot.id))
  ) {
    throw new SemanticPlanningError(
      'Proposal shot IDs must not reuse accepted shot identities',
    );
  }
  if (!planning) return;
  if (
    shots.length !== planning.targetShotCount &&
    !input.shotCountRationale.trim()
  ) {
    throw new SemanticPlanningError(
      `A count-deviation explanation is required when returning ${shots.length} shots instead of the soft target ${planning.targetShotCount}`,
    );
  }
  if (planning.briefs.length > 0) {
    if (shots.length !== planning.briefs.length) {
      throw new SemanticPlanningError(
        'Outline proposals must return one shot for every ordered brief',
      );
    }
    planning.briefs.forEach((brief, index) => {
      if (shots[index]?.briefId !== brief.id) {
        throw new SemanticPlanningError(
          `Shot ${index + 1} must map to outline brief ${brief.id}`,
        );
      }
    });
  }
  shots.forEach((shot, index) => {
    const firstWord = words[shot.startWordOrdinal];
    const lastWord = words[shot.endWordOrdinal];
    if (!firstWord || !lastWord) return;
    const wordCount = shot.endWordOrdinal - shot.startWordOrdinal + 1;
    const durationMs = lastWord.endMs - firstWord.startMs;
    if (
      planning.maxWordsPerShot !== null &&
      wordCount > planning.maxWordsPerShot
    ) {
      throw new SemanticPlanningError(
        `Shot ${index + 1} exceeds the ${planning.maxWordsPerShot}-word maximum`,
      );
    }
    if (
      planning.minDurationMs !== null &&
      durationMs < planning.minDurationMs
    ) {
      throw new SemanticPlanningError(
        `Shot ${index + 1} is shorter than the ${planning.minDurationMs} ms minimum`,
      );
    }
    if (
      planning.maxDurationMs !== null &&
      durationMs > planning.maxDurationMs
    ) {
      throw new SemanticPlanningError(
        `Shot ${index + 1} exceeds the ${planning.maxDurationMs} ms maximum`,
      );
    }
  });
}

function assertProposalRevisionCurrent(input: {
  baseRevision: number;
  baseTranscriptRevisionId: string;
  database: BetterSqlite3.Database;
  projectId: string;
  proposalId: string;
}): void {
  const project = input.database
    .prepare('SELECT revision FROM projects WHERE id = ?')
    .get(input.projectId) as { revision: number } | undefined;
  const transcript = input.database
    .prepare(
      `SELECT id FROM transcript_revisions WHERE project_id = ?
       ORDER BY revision DESC LIMIT 1`,
    )
    .get(input.projectId) as { id: string } | undefined;
  if (
    project?.revision === input.baseRevision &&
    transcript?.id === input.baseTranscriptRevisionId
  ) {
    return;
  }
  input.database
    .prepare("UPDATE editorial_proposals SET status = 'stale' WHERE id = ?")
    .run(input.proposalId);
  throw new SemanticPlanningError(
    'Proposal must be regenerated from current state',
    'STALE_PROPOSAL',
  );
}

export function assertProposalAdjustment(input: {
  database: BetterSqlite3.Database;
  planning: ShotPlanningRequest | null;
  prior: { metadata: ProposalMetadata; shots: StagedShotProposal[] };
  projectId: string;
  proposal: {
    base_revision: number;
    base_transcript_revision_id: string;
    id: string;
  };
  shots: StagedShotProposal[];
  words: TranscriptWord[];
}): void {
  assertProposalRevisionCurrent({
    baseRevision: input.proposal.base_revision,
    baseTranscriptRevisionId: input.proposal.base_transcript_revision_id,
    database: input.database,
    projectId: input.projectId,
    proposalId: input.proposal.id,
  });
  assertStableShotIdentities(input.prior.shots, input.shots);
  assertProposalMatchesPlanning({
    database: input.database,
    planning: input.planning,
    shotCountRationale: input.prior.metadata.shotCountRationale ?? '',
    shots: input.shots,
    words: input.words,
  });
}
