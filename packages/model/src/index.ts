export type ActorKind = 'human' | 'agent';

export type Actor = {
  id: string;
  kind: ActorKind;
};

export type ProjectOperation =
  | 'create_project'
  | 'ingest_narration'
  | 'import_transcript'
  | 'run_transcription'
  | 'create_proposal_task'
  | 'attach_candidate'
  | 'add_note'
  | 'recommend_candidate'
  | 'submit_proposal'
  | 'select_visual'
  | 'correct_transcript'
  | 'change_shots'
  | 'change_output_settings'
  | 'accept_proposal'
  | 'adjust_proposal'
  | 'reject_proposal'
  | 'export_incomplete';

export type ProjectSnapshot = {
  id: string;
  name: string;
  revision: number;
};

export type TranscriptWord = {
  id: string;
  ordinal: number;
  text: string;
  startMs: number;
  endMs: number;
};

export type IntakeProjectSnapshot = ProjectSnapshot & {
  sourceAudio: null | {
    id: string;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
    checksum: string;
    managedPath: string;
  };
  transcript: null | {
    id: string;
    revision: number;
    words: TranscriptWord[];
  };
  attempts: Array<{
    id: string;
    provider: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed';
    rawArtifactPath: string | null;
    errorMessage: string | null;
  }>;
};

export type EditorialWord = TranscriptWord;

export type EditorialProjectSnapshot = ProjectSnapshot & {
  rawTranscript: { id: string; revision: number; words: EditorialWord[] };
  effectiveTranscript: { id: string; revision: number; words: EditorialWord[] };
  tasks: Array<{
    id: string;
    status: string;
    instruction: string;
    baseRevision: number;
  }>;
  proposals: Array<{
    id: string;
    taskId: string;
    status: string;
    pacing: string;
    constraints: Record<string, unknown>;
    baseProjectRevision: number;
    baseTranscriptRevisionId: string;
    shots: Array<{
      endWordOrdinal: number;
      rationale: string;
      startWordOrdinal: number;
      theme: string;
    }>;
  }>;
  shots: Array<{
    id: string;
    ordinal: number;
    theme: string;
    rationale: string;
    startWordOrdinal: number;
    endWordOrdinal: number;
  }>;
  checkpoints: Array<{ id: string; name: string; revision: number }>;
};

export type LedgerShot = {
  id: string;
  ordinal: number;
  theme: string;
  rationale: string;
  startWordOrdinal: number;
  endWordOrdinal: number;
};

export type LedgerProjectSnapshot = ProjectSnapshot & {
  shots: LedgerShot[];
  ancestry: Array<{
    childShotId: string;
    parentShotId: string;
    relation: string;
  }>;
  checkpoints: Array<{ id: string; name: string; revision: number }>;
  history: Array<{
    actorId: string;
    actorKind: ActorKind;
    operation: ProjectOperation;
    revision: number;
  }>;
};

export type AssetProjectSnapshot = ProjectSnapshot & {
  assets: Array<{
    id: string;
    kind: 'image' | 'video';
    checksum: string;
    managedPath: string;
    mimeType: string;
    provenance: {
      actorId: string;
      actorKind: ActorKind;
      origin: string;
    };
  }>;
  shots: Array<{
    id: string;
    candidates: string[];
    recommendations: Array<{
      assetId: string;
      agentId: string;
      reason: string;
    }>;
    selectedAssetId: string | null;
  }>;
};

export type AgentTaskStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export type ActivitySnapshot = ProjectSnapshot & {
  tasks: Array<{
    id: string;
    kind: string;
    instruction: string;
    shotIds: string[];
    baseRevision: number;
    resultRevision: number | null;
    retryOfTaskId: string | null;
    status: AgentTaskStatus;
  }>;
  receipts: Array<{
    id: string;
    taskId: string;
    result: string;
    summary: string;
    projectRevision: number | null;
  }>;
};

export type OutputFormat = 'landscape' | 'vertical';
export type VisualFit = 'cover' | 'contain';
export type RenderJobStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'failed'
  | 'canceled'
  | 'succeeded';

export type FormatOverride = {
  captionsEnabled: boolean;
  fit: VisualFit;
  format: OutputFormat;
  shotId: string;
};

export type RenderPlan = {
  baseRevision: number;
  projectId: string;
  sourceAudioPath: string;
  shots: Array<{
    endMs: number;
    id: string;
    ordinal: number;
    overrides: Record<OutputFormat, Omit<FormatOverride, 'format' | 'shotId'>>;
    selectedAsset: null | {
      kind: 'image' | 'video';
      path: string;
    };
    startMs: number;
    theme: string;
    transcript: string;
  }>;
};

export type RenderArtifactSnapshot = {
  checksum: string;
  durationMs: number;
  format: OutputFormat;
  height: number;
  id: string;
  publishedPath: string;
  width: number;
};

export type RenderJobSnapshot = {
  artifacts: RenderArtifactSnapshot[];
  baseRevision: number;
  errorMessage: string | null;
  id: string;
  retryOfJobId: string | null;
  status: RenderJobStatus;
};

export type PreviewArtifactSnapshot = {
  baseRevision: number;
  durationMs: number;
  format: OutputFormat;
  id: string;
  shotId: string | null;
};

export type MediaProjectSnapshot = ProjectSnapshot & {
  jobs: RenderJobSnapshot[];
  overrides: FormatOverride[];
  preflight: {
    baseRevision: number;
    blockers: string[];
    incompleteShotIds: string[];
    requiresPlaceholderApproval: boolean;
    totalDurationMs: number;
    warnings: string[];
  };
  shots: RenderPlan['shots'];
};

export type ProjectEvent = {
  operation: ProjectOperation;
  projectId: string;
  revision: number;
};

const agentOperations = new Set<ProjectOperation>([
  'attach_candidate',
  'add_note',
  'recommend_candidate',
  'submit_proposal',
]);

const humanOperations = new Set<ProjectOperation>([
  'create_project',
  'ingest_narration',
  'import_transcript',
  'run_transcription',
  'create_proposal_task',
  'attach_candidate',
  'add_note',
  'select_visual',
  'correct_transcript',
  'change_shots',
  'change_output_settings',
  'accept_proposal',
  'adjust_proposal',
  'reject_proposal',
  'export_incomplete',
]);

export class AuthorityError extends Error {
  readonly code = 'FORBIDDEN';

  constructor(
    readonly actor: Actor,
    readonly operation: ProjectOperation,
  ) {
    super(`${actor.kind} actor ${actor.id} cannot perform ${operation}`);
    this.name = 'AuthorityError';
  }
}

export function assertAuthorized(actor: Actor, operation: ProjectOperation): void {
  const permitted = actor.kind === 'human' ? humanOperations : agentOperations;
  if (!permitted.has(operation)) throw new AuthorityError(actor, operation);
}
