import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import Database from 'better-sqlite3';

import {
  assertAuthorized,
  type ActivitySnapshot,
  type Actor,
  type ActorKind,
  type AgentTaskStatus,
  type AssetProjectSnapshot,
  type EditorialProjectSnapshot,
  type IntakeProjectSnapshot,
  type LedgerProjectSnapshot,
  type MediaProjectSnapshot,
  type OutputFormat,
  type ProjectEvent,
  type ProjectOperation,
  type ProjectSnapshot,
  type RenderArtifactSnapshot,
  type RenderJobSnapshot,
  type RenderPlan,
  type VisualFit,
} from '../../../packages/model/src/index.ts';
import type {
  ProviderWord,
  TranscriptProvider,
} from '../../../packages/transcription/src/index.ts';
import { applyMigrations } from './migrations.ts';
import {
  MediaIntakeError,
  narrationMedia,
  narrationMimeTypeForPath,
  persistNarration,
  removeManagedNarration,
  visualMedia,
  type ManagedNarration,
  type VisualMedia,
} from './narration.ts';

export type Credential = {
  role: ActorKind;
  scopes: string[];
  token: string;
};

type ProjectRow = {
  id: string;
  name: string;
  revision: number;
};

type CredentialRow = {
  role: ActorKind;
  scopes_json: string;
  revoked_at: string | null;
};

type StoreOptions = {
  importRoot?: string;
  managedRoot?: string;
};

type SourceAudioRow = {
  checksum: string;
  id: string;
  managed_path: string;
  mime_type: string;
  normalized_checksum: string;
  normalized_mime_type: 'audio/wav';
  original_name: string;
  original_path: string;
  size_bytes: number;
};

type AttemptRow = {
  error_message: string | null;
  id: string;
  provider: string;
  raw_artifact_path: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
};

type TranscriptRevisionRow = {
  id: string;
  revision: number;
};

type EditorialTranscriptRow = TranscriptRevisionRow & {
  attempt_id: string | null;
};

type ProposalRow = {
  base_revision: number;
  base_transcript_revision_id: string;
  constraints_json: string;
  id: string;
  pacing: string;
  status: string;
  task_id: string;
};

type LedgerVersionRow = {
  endWordOrdinal: number;
  first_word_id: string;
  id: string;
  last_word_id: string;
  ordinal: number;
  rationale: string;
  startWordOrdinal: number;
  theme: string;
};

type AgentTaskRow = {
  base_revision: number;
  id: string;
  instruction: string;
  kind: string;
  parent_task_id: string | null;
  result_revision: number | null;
  status: AgentTaskStatus;
  target_shot_ids_json: string;
};

type TaskReceiptRow = {
  id: string;
  project_revision: number | null;
  result: string;
  summary: string;
  task_id: string;
};

export type LedgerOperation =
  | { kind: 'reorder'; shotIds: string[] }
  | { kind: 'cut'; shotId: string }
  | { atWordOrdinal: number; kind: 'split'; shotId: string }
  | { kind: 'merge'; leftShotId: string; rightShotId: string }
  | {
      endWordOrdinal: number;
      kind: 'trim';
      shotId: string;
      startWordOrdinal: number;
    };

export class StoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function containsSecretMaterial(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretMaterial);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, child]) =>
      /(secret|api.?key|password|credential|token)/i.test(key) ||
      containsSecretMaterial(child),
  );
}

function snapshot(row: ProjectRow): ProjectSnapshot {
  return { id: row.id, name: row.name, revision: row.revision };
}

function assertValidWords(words: ProviderWord[]): void {
  if (!Array.isArray(words) || words.length === 0) {
    throw new StoreError(
      'INVALID_TRANSCRIPT',
      'Transcript must contain timestamped words',
    );
  }
  let previousEnd = 0;
  for (const [ordinal, word] of words.entries()) {
    if (
      typeof word.text !== 'string' ||
      !word.text.trim() ||
      !Number.isInteger(word.startMs) ||
      !Number.isInteger(word.endMs) ||
      word.startMs < previousEnd ||
      word.endMs <= word.startMs
    ) {
      throw new StoreError(
        'INVALID_TRANSCRIPT',
        `Word ${ordinal + 1} has malformed or non-chronological timestamps`,
      );
    }
    previousEnd = word.endMs;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
  );
}

export class ProjectStore {
  readonly #database: Database.Database;
  readonly #importRoot: string;
  readonly #listeners = new Set<(event: ProjectEvent) => void>();
  readonly #managedRoot: string;

  constructor(databasePath: string, options: StoreOptions = {}) {
    this.#database = new Database(databasePath);
    this.#managedRoot = resolve(
      options.managedRoot ?? join(dirname(databasePath), 'media'),
    );
    this.#importRoot = resolve(options.importRoot ?? dirname(databasePath));
    mkdirSync(this.#managedRoot, { recursive: true });
    mkdirSync(this.#importRoot, { recursive: true });
    applyMigrations(this.#database);
    const recoveredAt = new Date().toISOString();
    this.#database
      .prepare(
        `UPDATE jobs
         SET status = 'waiting',
             error_message = 'Service restarted while render was running',
             updated_at = ?
         WHERE status = 'running'`,
      )
      .run(recoveredAt);
  }

  close(): void {
    this.#database.close();
  }

  get managedRoot(): string {
    return this.#managedRoot;
  }

  createProject(input: { actor: Actor; name: string }): ProjectSnapshot {
    assertAuthorized(input.actor, 'create_project');
    const name = input.name.trim();
    if (!name)
      throw new StoreError('INVALID_INPUT', 'Project name is required');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database
        .prepare(
          'INSERT INTO projects (id, name, revision, created_at) VALUES (?, ?, 1, ?)',
        )
        .run(id, name, now);
      this.#database
        .prepare(
          `INSERT INTO project_revisions
           (project_id, revision, actor_kind, actor_id, operation, payload_json, created_at)
           VALUES (?, 1, ?, ?, 'create_project', ?, ?)`,
        )
        .run(
          id,
          input.actor.kind,
          input.actor.id,
          JSON.stringify({ name }),
          now,
        );
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return { id, name, revision: 1 };
  }

  getProject(projectId: string): ProjectSnapshot {
    const row = this.#database
      .prepare('SELECT id, name, revision FROM projects WHERE id = ?')
      .get(projectId) as ProjectRow | undefined;
    if (!row)
      throw new StoreError('NOT_FOUND', `Project ${projectId} was not found`);
    return snapshot(row);
  }

  applyMutation(input: {
    actor: Actor;
    expectedRevision: number;
    mutate?: (nextRevision: number, now: string) => void;
    operation: ProjectOperation;
    payload: Record<string, unknown>;
    projectId: string;
  }): ProjectSnapshot {
    assertAuthorized(input.actor, input.operation);
    if (containsSecretMaterial(input.payload)) {
      throw new StoreError(
        'SECRET_MATERIAL',
        'Provider secrets and credentials cannot enter project history',
      );
    }
    this.#database.exec('BEGIN IMMEDIATE');
    let result: ProjectSnapshot;
    try {
      const current = this.#database
        .prepare('SELECT id, name, revision FROM projects WHERE id = ?')
        .get(input.projectId) as ProjectRow | undefined;
      if (!current) {
        throw new StoreError(
          'NOT_FOUND',
          `Project ${input.projectId} was not found`,
        );
      }
      if (current.revision !== input.expectedRevision) {
        throw new StoreError(
          'REVISION_CONFLICT',
          `Expected revision ${input.expectedRevision}; current revision is ${current.revision}`,
        );
      }
      const revision = current.revision + 1;
      const now = new Date().toISOString();
      const payloadJson = JSON.stringify(input.payload);
      this.#database
        .prepare(
          'UPDATE projects SET revision = ? WHERE id = ? AND revision = ?',
        )
        .run(revision, input.projectId, current.revision);
      this.#database
        .prepare(
          `INSERT INTO project_revisions
           (project_id, revision, actor_kind, actor_id, operation, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.projectId,
          revision,
          input.actor.kind,
          input.actor.id,
          input.operation,
          payloadJson,
          now,
        );
      this.#database
        .prepare(
          `INSERT INTO change_events
           (id, project_id, revision, actor_kind, actor_id, operation, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.projectId,
          revision,
          input.actor.kind,
          input.actor.id,
          input.operation,
          payloadJson,
          now,
        );
      input.mutate?.(revision, now);
      this.#database.exec('COMMIT');
      result = { id: current.id, name: current.name, revision };
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    const event: ProjectEvent = {
      operation: input.operation,
      projectId: input.projectId,
      revision: result.revision,
    };
    for (const listener of this.#listeners) listener(event);
    return result;
  }

  ingestNarration(input: {
    actor: Actor;
    bytes: Buffer;
    expectedRevision: number;
    mimeType: string;
    originalName: string;
    projectId: string;
  }): IntakeProjectSnapshot {
    assertAuthorized(input.actor, 'ingest_narration');
    if (
      input.originalName !== basename(input.originalName) ||
      input.originalName.includes('/') ||
      input.originalName.includes('\\')
    ) {
      throw new StoreError(
        'UNSAFE_PATH',
        'Narration filename must not contain a path',
      );
    }
    const id = randomUUID();
    const directory = join(this.#managedRoot, input.projectId, 'source');
    let files: ManagedNarration;
    try {
      const media = narrationMedia(
        input.bytes,
        input.originalName,
        input.mimeType,
      );
      files = persistNarration({
        bytes: input.bytes,
        directory,
        id,
        media,
      });
    } catch (error) {
      if (error instanceof MediaIntakeError) {
        throw new StoreError(error.code, error.message);
      }
      throw error;
    }
    try {
      this.#commitIntakeRevision({
        actor: input.actor,
        expectedRevision: input.expectedRevision,
        operation: 'ingest_narration',
        payload: {
          checksum: files.checksum,
          mimeType: input.mimeType,
          normalizedChecksum: files.normalizedChecksum,
          normalizedMimeType: files.normalizedMimeType,
          originalName: input.originalName,
          sizeBytes: input.bytes.byteLength,
        },
        projectId: input.projectId,
        write: (revision, now) => {
          this.#database
            .prepare(
              `INSERT INTO source_audio
               (id, project_id, managed_path, checksum, duration_ms, created_at,
                original_name, mime_type, size_bytes, original_path,
                normalized_checksum, normalized_mime_type)
               VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              input.projectId,
              files.managedPath,
              files.checksum,
              now,
              input.originalName,
              input.mimeType,
              input.bytes.byteLength,
              files.originalPath,
              files.normalizedChecksum,
              files.normalizedMimeType,
            );
          return revision;
        },
      });
    } catch (error) {
      removeManagedNarration(files);
      throw error;
    }
    return this.getIntakeProject(input.projectId);
  }

  ingestNarrationPath(input: {
    actor: Actor;
    expectedRevision: number;
    path: string;
    projectId: string;
  }): IntakeProjectSnapshot {
    assertAuthorized(input.actor, 'ingest_narration');
    const requestedPath = resolve(input.path);
    if (!isWithin(this.#importRoot, requestedPath)) {
      throw new StoreError(
        'UNSAFE_PATH',
        'Import path is outside the configured import root',
      );
    }
    if (lstatSync(requestedPath).isSymbolicLink()) {
      throw new StoreError(
        'UNSAFE_PATH',
        'Symbolic-link narration imports are not allowed',
      );
    }
    const realImportRoot = realpathSync(this.#importRoot);
    const realSource = realpathSync(requestedPath);
    if (!isWithin(realImportRoot, realSource)) {
      throw new StoreError(
        'UNSAFE_PATH',
        'Narration import resolves outside its root',
      );
    }
    const bytes = readFileSync(realSource);
    return this.ingestNarration({
      actor: input.actor,
      bytes,
      expectedRevision: input.expectedRevision,
      mimeType: narrationMimeTypeForPath(realSource),
      originalName: basename(realSource),
      projectId: input.projectId,
    });
  }

  importTranscript(input: {
    actor: Actor;
    expectedRevision: number;
    projectId: string;
    provider?: string;
    raw: unknown;
    words: ProviderWord[];
  }): IntakeProjectSnapshot {
    assertAuthorized(input.actor, 'import_transcript');
    return this.#storeTranscript({
      ...input,
      provider: input.provider ?? 'json-import',
    });
  }

  async runTranscription(input: {
    actor: Actor;
    expectedRevision: number;
    projectId: string;
    provider: TranscriptProvider;
  }): Promise<IntakeProjectSnapshot> {
    assertAuthorized(input.actor, 'run_transcription');
    const current = this.getIntakeProject(input.projectId);
    if (current.revision !== input.expectedRevision) {
      throw new StoreError(
        'REVISION_CONFLICT',
        `Expected revision ${input.expectedRevision}; current revision is ${current.revision}`,
      );
    }
    if (!current.sourceAudio) {
      throw new StoreError(
        'INVALID_INPUT',
        'Narration audio is required before transcription',
      );
    }
    const attemptId = randomUUID();
    const jobId = randomUUID();
    const now = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO transcription_attempts
         (id, project_id, provider, status, raw_artifact_path, created_at, error_message)
         VALUES (?, ?, ?, 'running', NULL, ?, NULL)`,
      )
      .run(attemptId, input.projectId, input.provider.name, now);
    this.#database
      .prepare(
        `INSERT INTO jobs (id, project_id, kind, status, base_revision, created_at)
         VALUES (?, ?, 'transcription', 'running', ?, ?)`,
      )
      .run(jobId, input.projectId, input.expectedRevision, now);
    this.#database
      .prepare(
        `INSERT INTO job_attempts
         (id, job_id, ordinal, status, detail_json, created_at)
         VALUES (?, ?, 1, 'running', '{}', ?)`,
      )
      .run(randomUUID(), jobId, now);

    let result: Awaited<ReturnType<TranscriptProvider['transcribe']>>;
    try {
      result = await input.provider.transcribe({
        checksum: current.sourceAudio.normalizedChecksum,
        managedPath: current.sourceAudio.managedPath,
        mimeType: current.sourceAudio.normalizedMimeType,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Provider failed';
      this.#database
        .prepare(
          "UPDATE transcription_attempts SET status = 'failed', error_message = ? WHERE id = ?",
        )
        .run(message, attemptId);
      this.#database
        .prepare("UPDATE jobs SET status = 'failed' WHERE id = ?")
        .run(jobId);
      this.#database
        .prepare(
          "UPDATE job_attempts SET status = 'failed', detail_json = ? WHERE job_id = ?",
        )
        .run(JSON.stringify({ message }), jobId);
      throw new StoreError('PROVIDER_FAILED', message);
    }
    return this.#storeTranscript({
      actor: input.actor,
      attemptId,
      expectedRevision: input.expectedRevision,
      jobId,
      projectId: input.projectId,
      provider: input.provider.name,
      raw: result.raw,
      words: result.words,
    });
  }

  getIntakeProject(projectId: string): IntakeProjectSnapshot {
    const project = this.getProject(projectId);
    const source = this.#database
      .prepare(
        `SELECT id, managed_path, checksum, original_name, mime_type, size_bytes,
                original_path, normalized_checksum, normalized_mime_type
         FROM source_audio WHERE project_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(projectId) as SourceAudioRow | undefined;
    const transcriptRevision = this.#database
      .prepare(
        `SELECT id, revision FROM transcript_revisions
         WHERE project_id = ? AND kind = 'provider'
         ORDER BY revision DESC LIMIT 1`,
      )
      .get(projectId) as TranscriptRevisionRow | undefined;
    const words = transcriptRevision
      ? (this.#database
          .prepare(
            `SELECT id, ordinal, text, start_ms AS startMs, end_ms AS endMs
             FROM transcript_words WHERE transcript_revision_id = ? ORDER BY ordinal`,
          )
          .all(
            transcriptRevision.id,
          ) as IntakeProjectSnapshot['transcript'] extends {
          words: infer Words;
        }
          ? Words
          : never)
      : [];
    const attempts = this.#database
      .prepare(
        `SELECT id, provider, status, raw_artifact_path, error_message
         FROM transcription_attempts WHERE project_id = ?
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(projectId) as AttemptRow[];
    return {
      ...project,
      attempts: attempts.map((attempt) => ({
        errorMessage: attempt.error_message,
        id: attempt.id,
        provider: attempt.provider,
        rawArtifactPath: attempt.raw_artifact_path,
        status: attempt.status,
      })),
      sourceAudio: source
        ? {
            checksum: source.checksum,
            id: source.id,
            managedPath: source.managed_path,
            mimeType: source.mime_type,
            normalizedChecksum: source.normalized_checksum,
            normalizedMimeType: source.normalized_mime_type,
            originalName: source.original_name,
            originalPath: source.original_path,
            sizeBytes: source.size_bytes,
          }
        : null,
      transcript: transcriptRevision
        ? {
            id: transcriptRevision.id,
            revision: transcriptRevision.revision,
            words,
          }
        : null,
    };
  }

  #storeTranscript(input: {
    actor: Actor;
    attemptId?: string;
    expectedRevision: number;
    jobId?: string;
    projectId: string;
    provider: string;
    raw: unknown;
    words: ProviderWord[];
  }): IntakeProjectSnapshot {
    assertValidWords(input.words);
    if (containsSecretMaterial(input.raw)) {
      throw new StoreError(
        'SECRET_MATERIAL',
        'Provider secrets cannot enter raw transcript artifacts',
      );
    }
    const attemptId = input.attemptId ?? randomUUID();
    const transcriptId = randomUUID();
    const rawDirectory = join(
      this.#managedRoot,
      input.projectId,
      'transcripts',
    );
    mkdirSync(rawDirectory, { recursive: true });
    const rawPath = join(rawDirectory, `${attemptId}.json`);
    const temporaryPath = `${rawPath}.partial`;
    writeFileSync(temporaryPath, JSON.stringify(input.raw, null, 2), {
      flag: 'wx',
    });
    renameSync(temporaryPath, rawPath);
    try {
      this.#commitIntakeRevision({
        actor: input.actor,
        expectedRevision: input.expectedRevision,
        operation:
          input.provider === 'json-import'
            ? 'import_transcript'
            : 'run_transcription',
        payload: {
          attemptId,
          provider: input.provider,
          wordCount: input.words.length,
        },
        projectId: input.projectId,
        write: (_projectRevision, now) => {
          if (!input.attemptId) {
            this.#database
              .prepare(
                `INSERT INTO transcription_attempts
                 (id, project_id, provider, status, raw_artifact_path, created_at, error_message)
                 VALUES (?, ?, ?, 'succeeded', ?, ?, NULL)`,
              )
              .run(attemptId, input.projectId, input.provider, rawPath, now);
          } else {
            this.#database
              .prepare(
                `UPDATE transcription_attempts
                 SET status = 'succeeded', raw_artifact_path = ?, error_message = NULL
                 WHERE id = ?`,
              )
              .run(rawPath, attemptId);
          }
          const transcriptRevision = (
            this.#database
              .prepare(
                `SELECT COALESCE(MAX(revision), 0) + 1 AS revision
                   FROM transcript_revisions WHERE project_id = ?`,
              )
              .get(input.projectId) as { revision: number }
          ).revision;
          this.#database
            .prepare(
              `INSERT INTO transcript_revisions
               (id, project_id, attempt_id, revision, created_at)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              transcriptId,
              input.projectId,
              attemptId,
              transcriptRevision,
              now,
            );
          const insertWord = this.#database.prepare(
            `INSERT INTO transcript_words
             (id, transcript_revision_id, ordinal, text, start_ms, end_ms)
             VALUES (?, ?, ?, ?, ?, ?)`,
          );
          input.words.forEach((word, ordinal) => {
            insertWord.run(
              randomUUID(),
              transcriptId,
              ordinal,
              word.text,
              word.startMs,
              word.endMs,
            );
          });
          if (input.jobId) {
            this.#database
              .prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ?")
              .run(input.jobId);
            this.#database
              .prepare(
                "UPDATE job_attempts SET status = 'succeeded', detail_json = ? WHERE job_id = ?",
              )
              .run(JSON.stringify({ attemptId, transcriptId }), input.jobId);
          }
          return transcriptRevision;
        },
      });
    } catch (error) {
      try {
        unlinkSync(rawPath);
      } catch {
        // Preserve the database error.
      }
      throw error;
    }
    return this.getIntakeProject(input.projectId);
  }

  #commitIntakeRevision(input: {
    actor: Actor;
    expectedRevision: number;
    operation: ProjectOperation;
    payload: Record<string, unknown>;
    projectId: string;
    write: (revision: number, now: string) => number;
  }): ProjectSnapshot {
    if (containsSecretMaterial(input.payload)) {
      throw new StoreError(
        'SECRET_MATERIAL',
        'Credentials cannot enter project history',
      );
    }
    this.#database.exec('BEGIN IMMEDIATE');
    let result: ProjectSnapshot;
    try {
      const current = this.#database
        .prepare('SELECT id, name, revision FROM projects WHERE id = ?')
        .get(input.projectId) as ProjectRow | undefined;
      if (!current) {
        throw new StoreError(
          'NOT_FOUND',
          `Project ${input.projectId} was not found`,
        );
      }
      if (current.revision !== input.expectedRevision) {
        throw new StoreError(
          'REVISION_CONFLICT',
          `Expected revision ${input.expectedRevision}; current revision is ${current.revision}`,
        );
      }
      const revision = current.revision + 1;
      const now = new Date().toISOString();
      input.write(revision, now);
      this.#database
        .prepare(
          'UPDATE projects SET revision = ? WHERE id = ? AND revision = ?',
        )
        .run(revision, input.projectId, current.revision);
      const payloadJson = JSON.stringify(input.payload);
      this.#database
        .prepare(
          `INSERT INTO project_revisions
           (project_id, revision, actor_kind, actor_id, operation, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.projectId,
          revision,
          input.actor.kind,
          input.actor.id,
          input.operation,
          payloadJson,
          now,
        );
      this.#database
        .prepare(
          `INSERT INTO change_events
           (id, project_id, revision, actor_kind, actor_id, operation, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.projectId,
          revision,
          input.actor.kind,
          input.actor.id,
          input.operation,
          payloadJson,
          now,
        );
      this.#database.exec('COMMIT');
      result = { id: current.id, name: current.name, revision };
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    const event: ProjectEvent = {
      operation: input.operation,
      projectId: input.projectId,
      revision: result.revision,
    };
    for (const listener of this.#listeners) listener(event);
    return result;
  }

  correctTranscript(input: {
    actor: Actor;
    expectedRevision: number;
    projectId: string;
    replacementText: string;
    wordId: string;
  }): EditorialProjectSnapshot {
    assertAuthorized(input.actor, 'correct_transcript');
    const replacementText = input.replacementText.trim();
    if (!replacementText) {
      throw new StoreError('INVALID_INPUT', 'Replacement text is required');
    }
    const current = this.#currentEditorialTranscript(input.projectId);
    const words = this.#wordsForTranscript(current.id);
    const correctedOrdinal = words.findIndex(
      (word) => word.id === input.wordId,
    );
    if (correctedOrdinal === -1) {
      throw new StoreError(
        'INVALID_INPUT',
        'Correction word is not in the current transcript',
      );
    }
    const transcriptId = randomUUID();
    this.#commitIntakeRevision({
      actor: input.actor,
      expectedRevision: input.expectedRevision,
      operation: 'correct_transcript',
      payload: {
        replacementText,
        sourceWordId: input.wordId,
      },
      projectId: input.projectId,
      write: (_projectRevision, now) => {
        const revision = (
          this.#database
            .prepare(
              `SELECT COALESCE(MAX(revision), 0) + 1 AS revision
                 FROM transcript_revisions WHERE project_id = ?`,
            )
            .get(input.projectId) as { revision: number }
        ).revision;
        this.#database
          .prepare(
            `INSERT INTO transcript_revisions
             (id, project_id, attempt_id, revision, created_at, kind,
              base_transcript_revision_id)
             VALUES (?, ?, ?, ?, ?, 'correction', ?)`,
          )
          .run(
            transcriptId,
            input.projectId,
            current.attempt_id,
            revision,
            now,
            current.id,
          );
        const insert = this.#database.prepare(
          `INSERT INTO transcript_words
           (id, transcript_revision_id, ordinal, text, start_ms, end_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        words.forEach((word, ordinal) => {
          insert.run(
            randomUUID(),
            transcriptId,
            ordinal,
            ordinal === correctedOrdinal ? replacementText : word.text,
            word.startMs,
            word.endMs,
          );
        });
        this.#database
          .prepare(
            `INSERT INTO transcript_corrections
             (id, transcript_revision_id, first_word_id, last_word_id,
              replacement_text, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            transcriptId,
            input.wordId,
            input.wordId,
            replacementText,
            now,
          );
        return revision;
      },
    });
    return this.getEditorialProject(input.projectId);
  }

  createProposalTask(input: {
    actor: Actor;
    constraints: Record<string, unknown>;
    expectedRevision: number;
    instruction: string;
    pacing: string;
    projectId: string;
  }): { id: string; status: string } {
    assertAuthorized(input.actor, 'create_proposal_task');
    const project = this.getProject(input.projectId);
    if (project.revision !== input.expectedRevision) {
      throw new StoreError(
        'REVISION_CONFLICT',
        `Expected revision ${input.expectedRevision}; current revision is ${project.revision}`,
      );
    }
    this.#currentEditorialTranscript(input.projectId);
    const id = randomUUID();
    this.#database
      .prepare(
        `INSERT INTO agent_tasks
         (id, project_id, base_revision, status, instruction, created_at,
          pacing, constraints_json)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.expectedRevision,
        input.instruction,
        new Date().toISOString(),
        input.pacing,
        JSON.stringify(input.constraints),
      );
    return { id, status: 'queued' };
  }

  attachAgent(input: {
    actor: Actor;
    credentialHash: string;
    projectId: string;
  }): { id: string; status: string } {
    if (input.actor.kind !== 'agent') {
      throw new StoreError(
        'FORBIDDEN',
        'Only an agent credential can attach an agent session',
      );
    }
    this.getProject(input.projectId);
    const id = randomUUID();
    this.#database
      .prepare(
        `INSERT INTO agent_sessions
         (id, project_id, credential_hash, status, created_at)
         VALUES (?, ?, ?, 'attached', ?)`,
      )
      .run(id, input.projectId, input.credentialHash, new Date().toISOString());
    return { id, status: 'attached' };
  }

  claimProposalTask(input: {
    actor: Actor;
    projectId: string;
    sessionId: string;
    taskId: string;
  }): { id: string; status: string } {
    if (input.actor.kind !== 'agent') {
      throw new StoreError('FORBIDDEN', 'Only agents can claim proposal tasks');
    }
    const session = this.#database
      .prepare(
        `SELECT id FROM agent_sessions
         WHERE id = ? AND project_id = ? AND status = 'attached'`,
      )
      .get(input.sessionId, input.projectId);
    if (!session)
      throw new StoreError('DETACHED_AGENT', 'Attach an agent session first');
    const task = this.#database
      .prepare(
        `SELECT id FROM agent_tasks
         WHERE id = ? AND project_id = ? AND status = 'queued'`,
      )
      .get(input.taskId, input.projectId);
    if (!task)
      throw new StoreError(
        'TASK_UNAVAILABLE',
        'Task is not available to claim',
      );
    const claimId = randomUUID();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database
        .prepare(
          `INSERT INTO agent_claims
           (id, task_id, session_id, expires_at, released_at)
           VALUES (?, ?, ?, ?, NULL)`,
        )
        .run(
          claimId,
          input.taskId,
          input.sessionId,
          new Date(Date.now() + 15 * 60_000).toISOString(),
        );
      this.#database
        .prepare("UPDATE agent_tasks SET status = 'running' WHERE id = ?")
        .run(input.taskId);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return { id: claimId, status: 'running' };
  }

  submitShotProposal(input: {
    actor: Actor;
    baseProjectRevision: number;
    baseTranscriptRevisionId: string;
    credentialHash: string;
    projectId: string;
    shots: Array<{
      endWordOrdinal: number;
      rationale: string;
      startWordOrdinal: number;
      theme: string;
    }>;
    taskId: string;
  }): { id: string; status: string } {
    assertAuthorized(input.actor, 'submit_proposal');
    const task = this.#database
      .prepare(
        `SELECT base_revision, pacing, constraints_json FROM agent_tasks
         WHERE id = ? AND project_id = ? AND status IN ('claimed', 'running')`,
      )
      .get(input.taskId, input.projectId) as
      | { base_revision: number; constraints_json: string; pacing: string }
      | undefined;
    if (!task)
      throw new StoreError(
        'TASK_UNAVAILABLE',
        'Claim the task before submitting',
      );
    const claimed = this.#database
      .prepare(
        `SELECT 1 FROM agent_claims c
         JOIN agent_sessions s ON s.id = c.session_id
         WHERE c.task_id = ? AND c.released_at IS NULL
           AND s.credential_hash = ? AND s.status = 'attached'`,
      )
      .get(input.taskId, input.credentialHash);
    if (!claimed)
      throw new StoreError(
        'DETACHED_AGENT',
        'The submitting agent has no claim',
      );
    const current = this.#currentEditorialTranscript(input.projectId);
    const words = this.#wordsForTranscript(current.id);
    if (
      task.base_revision !== input.baseProjectRevision ||
      current.id !== input.baseTranscriptRevisionId
    ) {
      throw new StoreError(
        'STALE_PROPOSAL',
        'Proposal base revision is no longer current',
      );
    }
    if (input.shots.length === 0) {
      throw new StoreError(
        'INVALID_PROPOSAL',
        'Proposal must contain at least one shot',
      );
    }
    let expectedStart = 0;
    for (const [index, shot] of input.shots.entries()) {
      if (
        shot.startWordOrdinal !== expectedStart ||
        !Number.isInteger(shot.endWordOrdinal) ||
        shot.endWordOrdinal < shot.startWordOrdinal ||
        shot.endWordOrdinal >= words.length ||
        !shot.theme.trim() ||
        !shot.rationale.trim()
      ) {
        throw new StoreError(
          'INVALID_PROPOSAL',
          `Shot ${index + 1} does not preserve exact chronological coverage`,
        );
      }
      expectedStart = shot.endWordOrdinal + 1;
    }
    if (expectedStart !== words.length) {
      throw new StoreError(
        'INVALID_PROPOSAL',
        'Proposal does not cover every transcript word',
      );
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database
        .prepare(
          `INSERT INTO editorial_proposals
           (id, project_id, base_revision, status, created_at, task_id,
            base_transcript_revision_id, pacing, constraints_json)
           VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.baseProjectRevision,
          now,
          input.taskId,
          input.baseTranscriptRevisionId,
          task.pacing,
          task.constraints_json,
        );
      const insert = this.#database.prepare(
        `INSERT INTO proposal_operations
         (id, proposal_id, ordinal, operation, payload_json)
         VALUES (?, ?, ?, 'create_shot', ?)`,
      );
      input.shots.forEach((shot, ordinal) =>
        insert.run(randomUUID(), id, ordinal, JSON.stringify(shot)),
      );
      this.#database
        .prepare("UPDATE agent_tasks SET status = 'waiting' WHERE id = ?")
        .run(input.taskId);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    for (const listener of this.#listeners) {
      listener({
        operation: 'submit_proposal',
        projectId: input.projectId,
        revision: input.baseProjectRevision,
      });
    }
    return { id, status: 'ready' };
  }

  acceptShotProposal(input: {
    actor: Actor;
    expectedRevision: number;
    projectId: string;
    proposalId: string;
  }): EditorialProjectSnapshot {
    assertAuthorized(input.actor, 'accept_proposal');
    const proposal = this.#proposal(input.projectId, input.proposalId);
    const currentTranscript = this.#currentEditorialTranscript(input.projectId);
    const currentProject = this.getProject(input.projectId);
    if (
      proposal.status !== 'ready' ||
      proposal.base_revision !== currentProject.revision ||
      proposal.base_transcript_revision_id !== currentTranscript.id
    ) {
      this.#database
        .prepare("UPDATE editorial_proposals SET status = 'stale' WHERE id = ?")
        .run(input.proposalId);
      throw new StoreError(
        'STALE_PROPOSAL',
        'Proposal must be regenerated from current state',
      );
    }
    const operations = this.#database
      .prepare(
        `SELECT payload_json FROM proposal_operations
         WHERE proposal_id = ? ORDER BY ordinal`,
      )
      .all(input.proposalId) as Array<{ payload_json: string }>;
    const shots = operations.map(
      ({ payload_json }) =>
        JSON.parse(payload_json) as {
          endWordOrdinal: number;
          rationale: string;
          startWordOrdinal: number;
          theme: string;
        },
    );
    const words = this.#wordsForTranscript(currentTranscript.id);
    const sequenceId = randomUUID();
    this.#commitIntakeRevision({
      actor: input.actor,
      expectedRevision: input.expectedRevision,
      operation: 'accept_proposal',
      payload: { proposalId: input.proposalId, shotCount: shots.length },
      projectId: input.projectId,
      write: (revision, now) => {
        this.#database
          .prepare(
            `INSERT INTO edit_sequences (id, project_id, revision, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(sequenceId, input.projectId, revision, now);
        const insertShot = this.#database.prepare(
          `INSERT INTO shots
           (id, edit_sequence_id, ordinal, theme, created_at, rationale)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        const insertSpan = this.#database.prepare(
          `INSERT INTO shot_source_spans
           (id, shot_id, ordinal, first_word_id, last_word_id)
           VALUES (?, ?, 0, ?, ?)`,
        );
        const insertVersion = this.#database.prepare(
          `INSERT INTO shot_versions
           (edit_sequence_id, shot_id, ordinal, theme, rationale,
            first_word_id, last_word_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        shots.forEach((shot, ordinal) => {
          const shotId = randomUUID();
          const firstWordId = words[shot.startWordOrdinal]!.id;
          const lastWordId = words[shot.endWordOrdinal]!.id;
          insertShot.run(
            shotId,
            sequenceId,
            ordinal,
            shot.theme,
            now,
            shot.rationale,
          );
          insertSpan.run(randomUUID(), shotId, firstWordId, lastWordId);
          insertVersion.run(
            sequenceId,
            shotId,
            ordinal,
            shot.theme,
            shot.rationale,
            firstWordId,
            lastWordId,
          );
        });
        this.#database
          .prepare(
            "UPDATE editorial_proposals SET status = 'accepted' WHERE id = ?",
          )
          .run(input.proposalId);
        this.#database
          .prepare("UPDATE agent_tasks SET status = 'succeeded' WHERE id = ?")
          .run(proposal.task_id);
        this.#database
          .prepare(
            `INSERT INTO task_receipts
             (id, task_id, result, summary, created_at)
             VALUES (?, ?, 'succeeded', ?, ?)`,
          )
          .run(
            randomUUID(),
            proposal.task_id,
            `Accepted ${shots.length} chronological shots`,
            now,
          );
        this.#database
          .prepare(
            `INSERT INTO checkpoints (id, project_id, revision, name, created_at)
             VALUES (?, ?, ?, 'Accepted shot proposal', ?)`,
          )
          .run(randomUUID(), input.projectId, revision, now);
        return revision;
      },
    });
    return this.getEditorialProject(input.projectId);
  }

  adjustShotProposal(input: {
    actor: Actor;
    projectId: string;
    proposalId: string;
    shots: Array<{
      endWordOrdinal: number;
      rationale: string;
      startWordOrdinal: number;
      theme: string;
    }>;
  }): EditorialProjectSnapshot {
    assertAuthorized(input.actor, 'adjust_proposal');
    const proposal = this.#proposal(input.projectId, input.proposalId);
    if (proposal.status !== 'ready') {
      throw new StoreError(
        'STALE_PROPOSAL',
        'Only a ready proposal can be adjusted',
      );
    }
    const words = this.#wordsForTranscript(
      proposal.base_transcript_revision_id,
    );
    this.#assertExactShotCoverage(input.shots, words.length);
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database
        .prepare('DELETE FROM proposal_operations WHERE proposal_id = ?')
        .run(input.proposalId);
      const insert = this.#database.prepare(
        `INSERT INTO proposal_operations
         (id, proposal_id, ordinal, operation, payload_json)
         VALUES (?, ?, ?, 'create_shot', ?)`,
      );
      input.shots.forEach((shot, ordinal) =>
        insert.run(
          randomUUID(),
          input.proposalId,
          ordinal,
          JSON.stringify(shot),
        ),
      );
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return this.getEditorialProject(input.projectId);
  }

  rejectShotProposal(input: {
    actor: Actor;
    projectId: string;
    proposalId: string;
  }): EditorialProjectSnapshot {
    assertAuthorized(input.actor, 'reject_proposal');
    const proposal = this.#proposal(input.projectId, input.proposalId);
    if (proposal.status !== 'ready') {
      throw new StoreError(
        'STALE_PROPOSAL',
        'Only a ready proposal can be rejected',
      );
    }
    const now = new Date().toISOString();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database
        .prepare(
          "UPDATE editorial_proposals SET status = 'rejected' WHERE id = ?",
        )
        .run(input.proposalId);
      this.#database
        .prepare("UPDATE agent_tasks SET status = 'canceled' WHERE id = ?")
        .run(proposal.task_id);
      this.#database
        .prepare(
          `INSERT INTO task_receipts
           (id, task_id, result, summary, created_at)
           VALUES (?, ?, 'canceled', 'Human rejected the staged proposal', ?)`,
        )
        .run(randomUUID(), proposal.task_id, now);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return this.getEditorialProject(input.projectId);
  }

  createAssetTask(input: {
    actor: Actor;
    expectedRevision: number;
    instruction: string;
    projectId: string;
    shotIds: string[];
  }): ActivitySnapshot['tasks'][number] {
    if (input.actor.kind !== 'human') {
      throw new StoreError(
        'FORBIDDEN',
        'Only a human can dispatch an asset task',
      );
    }
    const project = this.getProject(input.projectId);
    if (project.revision !== input.expectedRevision) {
      throw new StoreError('REVISION_CONFLICT', 'Task base revision is stale');
    }
    const currentShotIds = new Set(
      this.#currentLedger(input.projectId).shots.map((shot) => shot.id),
    );
    if (
      input.shotIds.length === 0 ||
      new Set(input.shotIds).size !== input.shotIds.length ||
      input.shotIds.some((id) => !currentShotIds.has(id))
    ) {
      throw new StoreError(
        'INVALID_INPUT',
        'Task targets must be unique current shots',
      );
    }
    const instruction = input.instruction.trim();
    if (!instruction)
      throw new StoreError('INVALID_INPUT', 'Task instruction is required');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO agent_tasks
         (id, project_id, base_revision, status, instruction, created_at,
          pacing, constraints_json, kind, target_shot_ids_json, result_revision,
          updated_at)
         VALUES (?, ?, ?, 'queued', ?, ?, 'Standard', '{}', 'asset', ?, NULL, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.expectedRevision,
        instruction,
        now,
        JSON.stringify(input.shotIds),
        now,
      );
    return {
      baseRevision: input.expectedRevision,
      id,
      instruction,
      kind: 'asset',
      resultRevision: null,
      retryOfTaskId: null,
      shotIds: input.shotIds,
      status: 'queued',
    };
  }

  claimTask(input: {
    actor: Actor;
    credentialHash: string;
    leaseMs?: number;
    projectId: string;
    sessionId: string;
    taskId: string;
  }): ActivitySnapshot['tasks'][number] {
    if (input.actor.kind !== 'agent') {
      throw new StoreError('FORBIDDEN', 'Only an agent can claim work');
    }
    const session = this.#database
      .prepare(
        `SELECT id FROM agent_sessions
         WHERE id = ? AND project_id = ? AND credential_hash = ?
           AND status = 'attached'`,
      )
      .get(input.sessionId, input.projectId, input.credentialHash);
    if (!session)
      throw new StoreError('DETACHED_AGENT', 'Attach this agent first');
    const task = this.#task(input.projectId, input.taskId);
    if (task.status !== 'queued') {
      throw new StoreError(
        'TASK_UNAVAILABLE',
        'Task is already claimed or terminal',
      );
    }
    const now = new Date().toISOString();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database
        .prepare(
          `INSERT INTO agent_claims
           (id, task_id, session_id, expires_at, released_at, heartbeat_at)
           VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          randomUUID(),
          input.taskId,
          input.sessionId,
          new Date(Date.now() + (input.leaseMs ?? 15 * 60_000)).toISOString(),
          now,
        );
      this.#database
        .prepare(
          "UPDATE agent_tasks SET status = 'claimed', updated_at = ? WHERE id = ?",
        )
        .run(now, input.taskId);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return this.#activityTask(this.#task(input.projectId, input.taskId));
  }

  heartbeatTask(input: {
    actor: Actor;
    credentialHash: string;
    leaseMs?: number;
    projectId: string;
    taskId: string;
  }): { expiresAt: string; status: AgentTaskStatus } {
    if (input.actor.kind !== 'agent') {
      throw new StoreError(
        'FORBIDDEN',
        'Only the claiming agent can heartbeat',
      );
    }
    const task = this.#task(input.projectId, input.taskId);
    if (!['claimed', 'running', 'waiting'].includes(task.status)) {
      throw new StoreError('TASK_UNAVAILABLE', 'Task is not active');
    }
    const now = new Date().toISOString();
    const expiresAt = new Date(
      Date.now() + (input.leaseMs ?? 15 * 60_000),
    ).toISOString();
    const result = this.#database
      .prepare(
        `UPDATE agent_claims SET heartbeat_at = ?, expires_at = ?
         WHERE id = (
           SELECT c.id FROM agent_claims c
           JOIN agent_sessions s ON s.id = c.session_id
           WHERE c.task_id = ? AND c.released_at IS NULL
             AND s.credential_hash = ?
           ORDER BY c.expires_at DESC LIMIT 1
         )`,
      )
      .run(now, expiresAt, input.taskId, input.credentialHash);
    if (result.changes === 0) {
      throw new StoreError('DETACHED_AGENT', 'Agent does not own this claim');
    }
    return { expiresAt, status: task.status };
  }

  retryTask(input: {
    actor: Actor;
    expectedProjectRevision: number;
    projectId: string;
    taskId: string;
  }): ActivitySnapshot['tasks'][number] {
    if (input.actor.kind !== 'human') {
      throw new StoreError('FORBIDDEN', 'Only a human can retry a task');
    }
    const project = this.getProject(input.projectId);
    if (project.revision !== input.expectedProjectRevision) {
      throw new StoreError('REVISION_CONFLICT', 'Retry revision is stale');
    }
    const prior = this.#task(input.projectId, input.taskId);
    if (!['failed', 'canceled'].includes(prior.status)) {
      throw new StoreError(
        'INVALID_TASK_TRANSITION',
        'Only failed or canceled tasks can retry',
      );
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO agent_tasks
         (id, project_id, base_revision, status, instruction, created_at,
          pacing, constraints_json, kind, target_shot_ids_json, result_revision,
          updated_at, parent_task_id)
         VALUES (?, ?, ?, 'queued', ?, ?, 'Standard', '{}', ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        project.revision,
        prior.instruction,
        now,
        prior.kind,
        prior.target_shot_ids_json,
        now,
        prior.id,
      );
    return this.#activityTask(this.#task(input.projectId, id));
  }

  transitionTask(input: {
    actor: Actor;
    credentialHash: string;
    expectedProjectRevision: number;
    idempotencyKey: string;
    projectId: string;
    status: AgentTaskStatus;
    summary?: string;
    taskId: string;
  }): {
    id: string;
    receipt: ActivitySnapshot['receipts'][number] | null;
    status: AgentTaskStatus;
  } {
    const existingReceipt = this.#database
      .prepare(
        `SELECT id, task_id, result, summary, project_revision
         FROM task_receipts WHERE task_id = ? AND idempotency_key = ?`,
      )
      .get(input.taskId, input.idempotencyKey) as TaskReceiptRow | undefined;
    if (existingReceipt) {
      const task = this.#task(input.projectId, input.taskId);
      return {
        id: task.id,
        receipt: this.#activityReceipt(existingReceipt),
        status: task.status,
      };
    }
    const task = this.#task(input.projectId, input.taskId);
    const project = this.getProject(input.projectId);
    if (project.revision !== input.expectedProjectRevision) {
      throw new StoreError(
        'REVISION_CONFLICT',
        'Task transition revision is stale',
      );
    }
    const allowedRevision = task.result_revision ?? task.base_revision;
    if (input.expectedProjectRevision !== allowedRevision) {
      throw new StoreError(
        'STALE_TASK',
        `Task targets revision ${allowedRevision}, not ${input.expectedProjectRevision}`,
      );
    }
    if (input.actor.kind === 'agent') {
      const ownedClaim = this.#database
        .prepare(
          `SELECT 1 FROM agent_claims c
           JOIN agent_sessions s ON s.id = c.session_id
           WHERE c.task_id = ? AND c.released_at IS NULL
             AND s.credential_hash = ? AND s.status = 'attached'`,
        )
        .get(input.taskId, input.credentialHash);
      if (!ownedClaim)
        throw new StoreError('DETACHED_AGENT', 'Agent does not own this claim');
    } else if (input.status !== 'canceled') {
      throw new StoreError(
        'FORBIDDEN',
        'Humans may cancel tasks but not complete agent work',
      );
    }
    const transitions: Record<AgentTaskStatus, AgentTaskStatus[]> = {
      canceled: [],
      claimed: ['running', 'failed', 'canceled'],
      failed: [],
      queued: ['canceled'],
      running: ['waiting', 'succeeded', 'failed', 'canceled'],
      succeeded: [],
      waiting: ['running', 'failed', 'canceled'],
    };
    if (!transitions[task.status].includes(input.status)) {
      throw new StoreError(
        'INVALID_TASK_TRANSITION',
        `Cannot transition ${task.status} to ${input.status}`,
      );
    }
    const terminal = ['succeeded', 'failed', 'canceled'].includes(input.status);
    const now = new Date().toISOString();
    let receipt: ActivitySnapshot['receipts'][number] | null = null;
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database
        .prepare(
          'UPDATE agent_tasks SET status = ?, updated_at = ? WHERE id = ?',
        )
        .run(input.status, now, input.taskId);
      if (terminal) {
        const id = randomUUID();
        const summary =
          input.summary?.trim() || `${input.status} without summary`;
        this.#database
          .prepare(
            `INSERT INTO task_receipts
             (id, task_id, result, summary, created_at, idempotency_key,
              project_revision, detail_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.taskId,
            input.status,
            summary,
            now,
            input.idempotencyKey,
            project.revision,
            JSON.stringify({
              authority: input.actor.kind,
              shotIds: JSON.parse(task.target_shot_ids_json),
            }),
          );
        receipt = {
          id,
          projectRevision: project.revision,
          result: input.status,
          summary,
          taskId: input.taskId,
        };
        this.#database
          .prepare(
            'UPDATE agent_claims SET released_at = ? WHERE task_id = ? AND released_at IS NULL',
          )
          .run(now, input.taskId);
      }
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return { id: input.taskId, receipt, status: input.status };
  }

  getActivity(
    projectId: string,
    filter: { status?: AgentTaskStatus } = {},
  ): ActivitySnapshot {
    this.#reapExpiredClaims(projectId);
    const project = this.getProject(projectId);
    const rows = this.#database
      .prepare(
        `SELECT id, kind, instruction, target_shot_ids_json, base_revision,
                result_revision, status, parent_task_id
         FROM agent_tasks WHERE project_id = ?
           AND (? IS NULL OR status = ?)
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(
        projectId,
        filter.status ?? null,
        filter.status ?? null,
      ) as AgentTaskRow[];
    const receipts = this.#database
      .prepare(
        `SELECT r.id, r.task_id, r.result, r.summary, r.project_revision
         FROM task_receipts r
         JOIN agent_tasks t ON t.id = r.task_id
         WHERE t.project_id = ? ORDER BY r.created_at DESC, r.rowid DESC`,
      )
      .all(projectId) as TaskReceiptRow[];
    return {
      ...project,
      receipts: receipts.map((receipt) => this.#activityReceipt(receipt)),
      tasks: rows.map((task) => this.#activityTask(task)),
    };
  }

  uploadVisualCandidate(input: {
    actor: Actor;
    bytes: Buffer;
    expectedRevision: number;
    mimeType: string;
    originalName: string;
    projectId: string;
    shotIds: string[];
    taskId?: string;
    credentialHash?: string;
  }): AssetProjectSnapshot {
    assertAuthorized(input.actor, 'attach_candidate');
    if (
      input.originalName !== basename(input.originalName) ||
      input.originalName.includes('/') ||
      input.originalName.includes('\\')
    ) {
      throw new StoreError(
        'UNSAFE_PATH',
        'Visual filename must not contain a path',
      );
    }
    let media: VisualMedia;
    try {
      media = visualMedia(input.bytes, input.originalName, input.mimeType);
    } catch (error) {
      if (error instanceof MediaIntakeError) {
        throw new StoreError(error.code, error.message);
      }
      throw error;
    }
    const currentShotIds = new Set(
      this.#currentLedger(input.projectId).shots.map((shot) => shot.id),
    );
    if (
      input.shotIds.length === 0 ||
      new Set(input.shotIds).size !== input.shotIds.length ||
      input.shotIds.some((id) => !currentShotIds.has(id))
    ) {
      throw new StoreError(
        'INVALID_INPUT',
        'Every target must be a unique current shot',
      );
    }
    let task: AgentTaskRow | undefined;
    if (input.taskId) {
      task = this.#task(input.projectId, input.taskId);
      if (
        input.actor.kind !== 'agent' ||
        task.kind !== 'asset' ||
        !['claimed', 'running', 'waiting'].includes(task.status) ||
        task.base_revision !== input.expectedRevision
      ) {
        throw new StoreError(
          'STALE_TASK',
          'Asset task is not current and active',
        );
      }
      const ownedClaim = this.#database
        .prepare(
          `SELECT 1 FROM agent_claims c
           JOIN agent_sessions s ON s.id = c.session_id
           WHERE c.task_id = ? AND c.released_at IS NULL
             AND s.credential_hash = ?`,
        )
        .get(input.taskId, input.credentialHash ?? '');
      const taskTargets = new Set(
        JSON.parse(task.target_shot_ids_json) as string[],
      );
      if (!ownedClaim || input.shotIds.some((id) => !taskTargets.has(id))) {
        throw new StoreError(
          'FORBIDDEN',
          'Agent does not own this task or its targets',
        );
      }
    }
    const checksum = createHash('sha256').update(input.bytes).digest('hex');
    const existing = this.#database
      .prepare(
        `SELECT a.id, f.managed_path FROM assets a
         JOIN asset_files f ON f.asset_id = a.id
         WHERE a.project_id = ? AND f.checksum = ? LIMIT 1`,
      )
      .get(input.projectId, checksum) as
      { id: string; managed_path: string } | undefined;
    const assetId = existing?.id ?? randomUUID();
    const directory = join(this.#managedRoot, input.projectId, 'assets');
    mkdirSync(directory, { recursive: true });
    const managedPath =
      existing?.managed_path ??
      join(directory, `${checksum}${media.extension}`);
    let wroteFile = false;
    if (!existing) {
      const temporaryPath = `${managedPath}.${randomUUID()}.partial`;
      writeFileSync(temporaryPath, input.bytes, { flag: 'wx' });
      renameSync(temporaryPath, managedPath);
      wroteFile = true;
    }
    try {
      this.#commitIntakeRevision({
        actor: input.actor,
        expectedRevision: input.expectedRevision,
        operation: 'attach_candidate',
        payload: { assetId, checksum, shotIds: input.shotIds },
        projectId: input.projectId,
        write: (revision, now) => {
          if (!existing) {
            this.#database
              .prepare(
                `INSERT INTO assets (id, project_id, kind, created_at)
                 VALUES (?, ?, ?, ?)`,
              )
              .run(assetId, input.projectId, media.kind, now);
            this.#database
              .prepare(
                `INSERT INTO asset_files
                 (id, asset_id, managed_path, checksum, mime_type, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
              )
              .run(
                randomUUID(),
                assetId,
                managedPath,
                checksum,
                input.mimeType,
                now,
              );
            this.#database
              .prepare(
                `INSERT INTO asset_provenance
                 (id, asset_id, origin, actor_kind, actor_id, detail_json, created_at)
                 VALUES (?, ?, 'local-upload', ?, ?, ?, ?)`,
              )
              .run(
                randomUUID(),
                assetId,
                input.actor.kind,
                input.actor.id,
                JSON.stringify({ originalName: input.originalName }),
                now,
              );
          }
          const insertCandidate = this.#database.prepare(
            `INSERT OR IGNORE INTO shot_candidates
             (shot_id, asset_id, added_by, created_at) VALUES (?, ?, ?, ?)`,
          );
          input.shotIds.forEach((shotId) =>
            insertCandidate.run(shotId, assetId, input.actor.id, now),
          );
          if (task) {
            this.#database
              .prepare(
                `UPDATE agent_tasks
                 SET result_revision = ?, status = 'running', updated_at = ?
                 WHERE id = ?`,
              )
              .run(revision, now, task.id);
          }
          return input.shotIds.length;
        },
      });
    } catch (error) {
      if (wroteFile) {
        try {
          unlinkSync(managedPath);
        } catch {
          // Preserve the transaction error.
        }
      }
      throw error;
    }
    return this.getAssetProject(input.projectId);
  }

  selectVisual(input: {
    actor: Actor;
    assetId: string;
    expectedRevision: number;
    projectId: string;
    shotId: string;
  }): AssetProjectSnapshot {
    assertAuthorized(input.actor, 'select_visual');
    const candidate = this.#database
      .prepare(
        `SELECT 1 FROM shot_candidates WHERE shot_id = ? AND asset_id = ?`,
      )
      .get(input.shotId, input.assetId);
    if (!candidate) {
      throw new StoreError(
        'INVALID_INPUT',
        'The asset is not a candidate for this shot',
      );
    }
    this.#commitIntakeRevision({
      actor: input.actor,
      expectedRevision: input.expectedRevision,
      operation: 'select_visual',
      payload: { assetId: input.assetId, shotId: input.shotId },
      projectId: input.projectId,
      write: (_revision, now) => {
        this.#database
          .prepare(
            `INSERT INTO shot_selections
             (shot_id, asset_id, selected_by, selected_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(shot_id) DO UPDATE SET
               asset_id = excluded.asset_id,
               selected_by = excluded.selected_by,
               selected_at = excluded.selected_at`,
          )
          .run(input.shotId, input.assetId, input.actor.id, now);
        return 1;
      },
    });
    return this.getAssetProject(input.projectId);
  }

  clearVisual(input: {
    actor: Actor;
    expectedRevision: number;
    projectId: string;
    shotId: string;
  }): AssetProjectSnapshot {
    assertAuthorized(input.actor, 'select_visual');
    this.#commitIntakeRevision({
      actor: input.actor,
      expectedRevision: input.expectedRevision,
      operation: 'select_visual',
      payload: { action: 'clear', shotId: input.shotId },
      projectId: input.projectId,
      write: () => {
        this.#database
          .prepare('DELETE FROM shot_selections WHERE shot_id = ?')
          .run(input.shotId);
        return 1;
      },
    });
    return this.getAssetProject(input.projectId);
  }

  recommendVisual(input: {
    actor: Actor;
    assetId: string;
    expectedRevision: number;
    projectId: string;
    reason: string;
    shotId: string;
  }): AssetProjectSnapshot {
    assertAuthorized(input.actor, 'recommend_candidate');
    const candidate = this.#database
      .prepare(
        'SELECT 1 FROM shot_candidates WHERE shot_id = ? AND asset_id = ?',
      )
      .get(input.shotId, input.assetId);
    if (!candidate) {
      throw new StoreError(
        'INVALID_INPUT',
        'Only an attached candidate can be recommended',
      );
    }
    const reason = input.reason.trim();
    if (!reason)
      throw new StoreError(
        'INVALID_INPUT',
        'Recommendation reason is required',
      );
    this.#commitIntakeRevision({
      actor: input.actor,
      expectedRevision: input.expectedRevision,
      operation: 'recommend_candidate',
      payload: {
        assetId: input.assetId,
        reason,
        shotId: input.shotId,
      },
      projectId: input.projectId,
      write: (_revision, now) => {
        this.#database
          .prepare(
            `INSERT INTO shot_candidate_recommendations
             (shot_id, asset_id, agent_id, reason, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(shot_id, asset_id, agent_id)
             DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at`,
          )
          .run(input.shotId, input.assetId, input.actor.id, reason, now);
        return 1;
      },
    });
    return this.getAssetProject(input.projectId);
  }

  getAssetProject(projectId: string): AssetProjectSnapshot {
    const project = this.getProject(projectId);
    const ledger = this.#currentLedger(projectId);
    const assets = this.#database
      .prepare(
        `SELECT a.id, a.kind, f.checksum, f.managed_path, f.mime_type,
                p.actor_id, p.actor_kind, p.origin
         FROM assets a
         JOIN asset_files f ON f.asset_id = a.id
         JOIN asset_provenance p ON p.asset_id = a.id
         WHERE a.project_id = ? ORDER BY a.created_at, a.rowid`,
      )
      .all(projectId) as Array<{
      actor_id: string;
      actor_kind: ActorKind;
      checksum: string;
      id: string;
      kind: 'image' | 'video';
      managed_path: string;
      mime_type: string;
      origin: string;
    }>;
    return {
      ...project,
      assets: assets.map((asset) => ({
        checksum: asset.checksum,
        id: asset.id,
        kind: asset.kind,
        managedPath: asset.managed_path,
        mimeType: asset.mime_type,
        provenance: {
          actorId: asset.actor_id,
          actorKind: asset.actor_kind,
          origin: asset.origin,
        },
      })),
      shots: ledger.shots.map((shot) => {
        const candidates = this.#database
          .prepare(
            `SELECT asset_id FROM shot_candidates
             WHERE shot_id = ? ORDER BY created_at, rowid`,
          )
          .all(shot.id) as Array<{ asset_id: string }>;
        const selection = this.#database
          .prepare('SELECT asset_id FROM shot_selections WHERE shot_id = ?')
          .get(shot.id) as { asset_id: string } | undefined;
        const recommendations = this.#database
          .prepare(
            `SELECT asset_id, agent_id, reason
             FROM shot_candidate_recommendations
             WHERE shot_id = ? ORDER BY created_at, rowid`,
          )
          .all(shot.id) as Array<{
          agent_id: string;
          asset_id: string;
          reason: string;
        }>;
        return {
          candidates: candidates.map(({ asset_id }) => asset_id),
          id: shot.id,
          recommendations: recommendations.map((recommendation) => ({
            agentId: recommendation.agent_id,
            assetId: recommendation.asset_id,
            reason: recommendation.reason,
          })),
          selectedAssetId: selection?.asset_id ?? null,
        };
      }),
    };
  }

  setFormatOverride(input: {
    actor: Actor;
    captionsEnabled: boolean;
    expectedRevision: number;
    fit: VisualFit;
    format: OutputFormat;
    projectId: string;
    shotId: string;
  }): MediaProjectSnapshot {
    if (input.actor.kind !== 'human') {
      throw new StoreError(
        'FORBIDDEN',
        'Only a human can change output settings',
      );
    }
    if (!['landscape', 'vertical'].includes(input.format)) {
      throw new StoreError('INVALID_INPUT', 'Unknown output format');
    }
    if (!['cover', 'contain'].includes(input.fit)) {
      throw new StoreError('INVALID_INPUT', 'Unknown visual fit');
    }
    const ledger = this.getLedgerProject(input.projectId);
    if (!ledger.shots.some((shot) => shot.id === input.shotId)) {
      throw new StoreError('NOT_FOUND', 'Shot was not found');
    }
    this.applyMutation({
      actor: input.actor,
      expectedRevision: input.expectedRevision,
      mutate: () => {
        this.#database
          .prepare(
            `INSERT INTO format_overrides
             (id, shot_id, format, fit, captions_enabled)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(shot_id, format)
             DO UPDATE SET fit = excluded.fit,
                           captions_enabled = excluded.captions_enabled`,
          )
          .run(
            randomUUID(),
            input.shotId,
            input.format,
            input.fit,
            input.captionsEnabled ? 1 : 0,
          );
      },
      operation: 'change_output_settings',
      payload: {
        captionsEnabled: input.captionsEnabled,
        fit: input.fit,
        format: input.format,
        shotId: input.shotId,
      },
      projectId: input.projectId,
    });
    return this.getMediaProject(input.projectId);
  }

  getPreflight(projectId: string): MediaProjectSnapshot['preflight'] {
    const plan = this.#renderPlan(projectId);
    const blockers: string[] = [];
    const warnings: string[] = [];
    const incompleteShotIds: string[] = [];
    if (!plan.sourceAudioPath || !existsSync(plan.sourceAudioPath)) {
      blockers.push('Narration audio is missing or unreadable.');
    }
    if (plan.shots.length === 0)
      blockers.push('The edit has no accepted shots.');
    for (const shot of plan.shots) {
      if (shot.endMs <= shot.startMs) {
        blockers.push(`Shot ${shot.id} has an invalid source range.`);
      }
      if (!shot.selectedAsset) {
        incompleteShotIds.push(shot.id);
      } else if (!existsSync(shot.selectedAsset.path)) {
        blockers.push(`Shot ${shot.id} has unreadable selected media.`);
      }
    }
    if (incompleteShotIds.length) {
      warnings.push(
        `${incompleteShotIds.length} shots will use unmistakable missing-visual placeholders.`,
      );
    }
    return {
      baseRevision: plan.baseRevision,
      blockers,
      incompleteShotIds,
      requiresPlaceholderApproval: incompleteShotIds.length > 0,
      totalDurationMs: plan.shots.reduce(
        (total, shot) => total + shot.endMs - shot.startMs,
        0,
      ),
      warnings,
    };
  }

  getMediaProject(projectId: string): MediaProjectSnapshot {
    const project = this.getProject(projectId);
    const plan = this.#renderPlan(projectId);
    return {
      ...project,
      jobs: this.#renderJobs(projectId),
      overrides: plan.shots.flatMap((shot) =>
        (['landscape', 'vertical'] as OutputFormat[]).map((format) => ({
          captionsEnabled: shot.overrides[format].captionsEnabled,
          fit: shot.overrides[format].fit,
          format,
          shotId: shot.id,
        })),
      ),
      preflight: this.getPreflight(projectId),
      shots: plan.shots,
    };
  }

  getPreviewPlan(input: {
    expectedRevision: number;
    format: OutputFormat;
    projectId: string;
    shotId?: string;
  }): RenderPlan {
    const project = this.getProject(input.projectId);
    if (project.revision !== input.expectedRevision) {
      throw new StoreError(
        'REVISION_CONFLICT',
        `Preview revision ${input.expectedRevision} is stale; current revision is ${project.revision}`,
      );
    }
    if (!['landscape', 'vertical'].includes(input.format)) {
      throw new StoreError('INVALID_INPUT', 'Choose a valid preview format');
    }
    const preflight = this.getPreflight(input.projectId);
    if (preflight.blockers.length) {
      throw new StoreError('PREFLIGHT_BLOCKED', preflight.blockers.join(' '));
    }
    const plan = this.#renderPlan(input.projectId);
    if (!input.shotId) return plan;
    const shot = plan.shots.find((candidate) => candidate.id === input.shotId);
    if (!shot) throw new StoreError('NOT_FOUND', 'Preview shot was not found');
    return { ...plan, shots: [shot] };
  }

  createRenderJob(input: {
    actor: Actor;
    allowPlaceholders: boolean;
    expectedRevision: number;
    formats: OutputFormat[];
    projectId: string;
  }): RenderJobSnapshot {
    if (input.actor.kind !== 'human') {
      throw new StoreError('FORBIDDEN', 'Only a human can authorize a render');
    }
    const project = this.getProject(input.projectId);
    if (project.revision !== input.expectedRevision) {
      throw new StoreError(
        'REVISION_CONFLICT',
        `Preflight revision ${input.expectedRevision} is stale; current revision is ${project.revision}`,
      );
    }
    const formats = [...new Set(input.formats)];
    if (
      formats.length === 0 ||
      formats.some((format) => !['landscape', 'vertical'].includes(format))
    ) {
      throw new StoreError(
        'INVALID_INPUT',
        'Choose at least one valid output format',
      );
    }
    const preflight = this.getPreflight(input.projectId);
    if (preflight.blockers.length) {
      throw new StoreError('PREFLIGHT_BLOCKED', preflight.blockers.join(' '));
    }
    if (preflight.requiresPlaceholderApproval && !input.allowPlaceholders) {
      throw new StoreError(
        'PLACEHOLDER_APPROVAL_REQUIRED',
        'A human must authorize incomplete output placeholders',
      );
    }
    const plan = this.#renderPlan(input.projectId);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO jobs
         (id, project_id, kind, status, base_revision, created_at, updated_at,
          error_message, allow_placeholders, output_formats_json, plan_json,
          parent_job_id)
         VALUES (?, ?, 'render', 'queued', ?, ?, ?, NULL, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        input.projectId,
        input.expectedRevision,
        now,
        now,
        input.allowPlaceholders ? 1 : 0,
        JSON.stringify(formats),
        JSON.stringify(plan),
      );
    return this.#renderJob(input.projectId, id);
  }

  beginRenderJob(
    projectId: string,
    jobId: string,
  ): {
    formats: OutputFormat[];
    plan: RenderPlan;
  } {
    const row = this.#database
      .prepare(
        `SELECT status, plan_json, output_formats_json
         FROM jobs WHERE id = ? AND project_id = ? AND kind = 'render'`,
      )
      .get(jobId, projectId) as
      | {
          output_formats_json: string;
          plan_json: string | null;
          status: string;
        }
      | undefined;
    if (!row) throw new StoreError('NOT_FOUND', 'Render job was not found');
    if (!['queued', 'waiting'].includes(row.status)) {
      throw new StoreError(
        'INVALID_TASK_TRANSITION',
        'Render job is not runnable',
      );
    }
    if (!row.plan_json)
      throw new StoreError('INVALID_INPUT', 'Render plan is missing');
    const now = new Date().toISOString();
    this.#database
      .prepare(
        "UPDATE jobs SET status = 'running', error_message = NULL, updated_at = ? WHERE id = ?",
      )
      .run(now, jobId);
    this.#database
      .prepare(
        `INSERT INTO job_attempts
         (id, job_id, ordinal, status, detail_json, created_at, idempotency_key)
         VALUES (?, ?, COALESCE((SELECT MAX(ordinal) + 1 FROM job_attempts WHERE job_id = ?), 1),
                 'running', '{}', ?, ?)`,
      )
      .run(randomUUID(), jobId, jobId, now, `run:${now}`);
    return {
      formats: JSON.parse(row.output_formats_json) as OutputFormat[],
      plan: JSON.parse(row.plan_json) as RenderPlan,
    };
  }

  completeRenderJob(
    projectId: string,
    jobId: string,
    artifacts: Array<Omit<RenderArtifactSnapshot, 'id'>>,
  ): RenderJobSnapshot {
    const job = this.#renderJob(projectId, jobId);
    if (job.status !== 'running') {
      throw new StoreError(
        'INVALID_TASK_TRANSITION',
        'Render job is not running',
      );
    }
    const now = new Date().toISOString();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.#database.prepare(
        `INSERT INTO render_artifacts
         (id, job_id, format, published_path, checksum, created_at,
          width, height, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      artifacts.forEach((artifact) =>
        insert.run(
          randomUUID(),
          jobId,
          artifact.format,
          artifact.publishedPath,
          artifact.checksum,
          now,
          artifact.width,
          artifact.height,
          artifact.durationMs,
        ),
      );
      this.#database
        .prepare(
          "UPDATE jobs SET status = 'succeeded', updated_at = ?, error_message = NULL WHERE id = ?",
        )
        .run(now, jobId);
      this.#database
        .prepare(
          `UPDATE job_attempts SET status = 'succeeded',
             detail_json = ? WHERE job_id = ? AND status = 'running'`,
        )
        .run(JSON.stringify({ artifactCount: artifacts.length }), jobId);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return this.#renderJob(projectId, jobId);
  }

  failRenderJob(
    projectId: string,
    jobId: string,
    message: string,
  ): RenderJobSnapshot {
    const now = new Date().toISOString();
    this.#database
      .prepare(
        "UPDATE jobs SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ? AND project_id = ?",
      )
      .run(message, now, jobId, projectId);
    this.#database
      .prepare(
        `UPDATE job_attempts SET status = 'failed', detail_json = ?
         WHERE job_id = ? AND status = 'running'`,
      )
      .run(JSON.stringify({ message }), jobId);
    return this.#renderJob(projectId, jobId);
  }

  cancelRenderJob(input: {
    actor: Actor;
    jobId: string;
    projectId: string;
  }): RenderJobSnapshot {
    if (input.actor.kind !== 'human') {
      throw new StoreError('FORBIDDEN', 'Only a human can cancel a render');
    }
    const job = this.#renderJob(input.projectId, input.jobId);
    if (!['queued', 'waiting'].includes(job.status)) {
      throw new StoreError(
        'INVALID_TASK_TRANSITION',
        'Only queued or waiting renders can cancel',
      );
    }
    const now = new Date().toISOString();
    this.#database
      .prepare(
        "UPDATE jobs SET status = 'canceled', updated_at = ? WHERE id = ?",
      )
      .run(now, input.jobId);
    this.#database
      .prepare(
        `INSERT INTO job_attempts
         (id, job_id, ordinal, status, detail_json, created_at, idempotency_key)
         VALUES (?, ?, COALESCE((SELECT MAX(ordinal) + 1 FROM job_attempts WHERE job_id = ?), 1),
                 'canceled', '{}', ?, ?)`,
      )
      .run(
        randomUUID(),
        input.jobId,
        input.jobId,
        now,
        `cancel:${input.jobId}`,
      );
    return this.#renderJob(input.projectId, input.jobId);
  }

  retryRenderJob(input: {
    actor: Actor;
    expectedProjectRevision: number;
    jobId: string;
    projectId: string;
  }): RenderJobSnapshot {
    if (input.actor.kind !== 'human') {
      throw new StoreError('FORBIDDEN', 'Only a human can retry a render');
    }
    const project = this.getProject(input.projectId);
    if (project.revision !== input.expectedProjectRevision) {
      throw new StoreError('REVISION_CONFLICT', 'Retry revision is stale');
    }
    const prior = this.#database
      .prepare(
        `SELECT base_revision, allow_placeholders, output_formats_json, plan_json, status
         FROM jobs WHERE id = ? AND project_id = ?`,
      )
      .get(input.jobId, input.projectId) as
      | {
          allow_placeholders: number;
          base_revision: number;
          output_formats_json: string;
          plan_json: string;
          status: string;
        }
      | undefined;
    if (!prior) throw new StoreError('NOT_FOUND', 'Render job was not found');
    if (!['failed', 'canceled', 'waiting'].includes(prior.status)) {
      throw new StoreError(
        'INVALID_TASK_TRANSITION',
        'Render job cannot be retried',
      );
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO jobs
         (id, project_id, kind, status, base_revision, created_at, updated_at,
          error_message, allow_placeholders, output_formats_json, plan_json,
          parent_job_id)
         VALUES (?, ?, 'render', 'queued', ?, ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        prior.base_revision,
        now,
        now,
        prior.allow_placeholders,
        prior.output_formats_json,
        prior.plan_json,
        input.jobId,
      );
    return this.#renderJob(input.projectId, id);
  }

  getRenderArtifact(
    projectId: string,
    artifactId: string,
  ): { checksum: string; path: string } {
    const row = this.#database
      .prepare(
        `SELECT a.published_path, a.checksum
         FROM render_artifacts a
         JOIN jobs j ON j.id = a.job_id
         WHERE a.id = ? AND j.project_id = ?`,
      )
      .get(artifactId, projectId) as
      { checksum: string; published_path: string } | undefined;
    if (!row)
      throw new StoreError('NOT_FOUND', 'Render artifact was not found');
    if (!isWithin(this.#managedRoot, resolve(row.published_path))) {
      throw new StoreError(
        'UNSAFE_PATH',
        'Artifact path escaped managed media',
      );
    }
    return { checksum: row.checksum, path: row.published_path };
  }

  #renderPlan(projectId: string): RenderPlan {
    const project = this.getProject(projectId);
    const ledger = this.getLedgerProject(projectId);
    const editorial = this.getEditorialProject(projectId);
    const source = this.#database
      .prepare(
        `SELECT managed_path FROM source_audio
         WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId) as { managed_path: string } | undefined;
    const overrideRows = this.#database
      .prepare(
        `SELECT shot_id, format, fit, captions_enabled
         FROM format_overrides
         WHERE shot_id IN (
           SELECT shot_id FROM shot_versions
           WHERE edit_sequence_id = (
             SELECT id FROM edit_sequences
             WHERE project_id = ? ORDER BY revision DESC LIMIT 1
           )
         )`,
      )
      .all(projectId) as Array<{
      captions_enabled: number;
      fit: VisualFit;
      format: OutputFormat;
      shot_id: string;
    }>;
    return {
      baseRevision: project.revision,
      projectId,
      shots: ledger.shots.map((shot) => {
        const words = editorial.effectiveTranscript.words.slice(
          shot.startWordOrdinal,
          shot.endWordOrdinal + 1,
        );
        const selected = this.#database
          .prepare(
            `SELECT a.kind, f.managed_path
             FROM shot_selections s
             JOIN assets a ON a.id = s.asset_id
             JOIN asset_files f ON f.asset_id = a.id
             WHERE s.shot_id = ?`,
          )
          .get(shot.id) as
          { kind: 'image' | 'video'; managed_path: string } | undefined;
        const resolved = (format: OutputFormat) => {
          const row = overrideRows.find(
            (override) =>
              override.shot_id === shot.id && override.format === format,
          );
          return {
            captionsEnabled:
              row?.captions_enabled === 1 || (!row && format === 'vertical'),
            fit: row?.fit ?? (format === 'landscape' ? 'cover' : 'contain'),
          };
        };
        return {
          endMs: words.at(-1)?.endMs ?? 0,
          id: shot.id,
          ordinal: shot.ordinal,
          overrides: {
            landscape: resolved('landscape'),
            vertical: resolved('vertical'),
          },
          selectedAsset: selected
            ? { kind: selected.kind, path: selected.managed_path }
            : null,
          startMs: words[0]?.startMs ?? 0,
          theme: shot.theme,
          transcript: words.map((word) => word.text).join(' '),
        };
      }),
      sourceAudioPath: source?.managed_path ?? '',
    };
  }

  #renderJobs(projectId: string): RenderJobSnapshot[] {
    const rows = this.#database
      .prepare(
        `SELECT id, base_revision, status, error_message, parent_job_id
         FROM jobs WHERE project_id = ? AND kind = 'render'
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(projectId) as Array<{
      base_revision: number;
      error_message: string | null;
      id: string;
      parent_job_id: string | null;
      status: RenderJobSnapshot['status'];
    }>;
    return rows.map((row) => this.#renderJobFromRow(row));
  }

  #renderJob(projectId: string, jobId: string): RenderJobSnapshot {
    const row = this.#database
      .prepare(
        `SELECT id, base_revision, status, error_message, parent_job_id
         FROM jobs WHERE id = ? AND project_id = ? AND kind = 'render'`,
      )
      .get(jobId, projectId) as
      | {
          base_revision: number;
          error_message: string | null;
          id: string;
          parent_job_id: string | null;
          status: RenderJobSnapshot['status'];
        }
      | undefined;
    if (!row) throw new StoreError('NOT_FOUND', 'Render job was not found');
    return this.#renderJobFromRow(row);
  }

  #renderJobFromRow(row: {
    base_revision: number;
    error_message: string | null;
    id: string;
    parent_job_id: string | null;
    status: RenderJobSnapshot['status'];
  }): RenderJobSnapshot {
    const artifacts = this.#database
      .prepare(
        `SELECT id, format, published_path, checksum, width, height, duration_ms
         FROM render_artifacts WHERE job_id = ? ORDER BY format`,
      )
      .all(row.id) as Array<{
      checksum: string;
      duration_ms: number;
      format: OutputFormat;
      height: number;
      id: string;
      published_path: string;
      width: number;
    }>;
    return {
      artifacts: artifacts.map((artifact) => ({
        checksum: artifact.checksum,
        durationMs: artifact.duration_ms,
        format: artifact.format,
        height: artifact.height,
        id: artifact.id,
        publishedPath: artifact.published_path,
        width: artifact.width,
      })),
      baseRevision: row.base_revision,
      errorMessage: row.error_message,
      id: row.id,
      retryOfJobId: row.parent_job_id,
      status: row.status,
    };
  }

  #task(projectId: string, taskId: string): AgentTaskRow {
    const task = this.#database
      .prepare(
        `SELECT id, kind, instruction, target_shot_ids_json, base_revision,
                result_revision, status, parent_task_id
         FROM agent_tasks WHERE id = ? AND project_id = ?`,
      )
      .get(taskId, projectId) as AgentTaskRow | undefined;
    if (!task) throw new StoreError('NOT_FOUND', 'Task was not found');
    return task;
  }

  #activityTask(task: AgentTaskRow): ActivitySnapshot['tasks'][number] {
    return {
      baseRevision: task.base_revision,
      id: task.id,
      instruction: task.instruction,
      kind: task.kind,
      resultRevision: task.result_revision,
      retryOfTaskId: task.parent_task_id,
      shotIds: JSON.parse(task.target_shot_ids_json) as string[],
      status: task.status,
    };
  }

  #activityReceipt(
    receipt: TaskReceiptRow,
  ): ActivitySnapshot['receipts'][number] {
    return {
      id: receipt.id,
      projectRevision: receipt.project_revision,
      result: receipt.result,
      summary: receipt.summary,
      taskId: receipt.task_id,
    };
  }

  #reapExpiredClaims(projectId: string): void {
    const expired = this.#database
      .prepare(
        `SELECT c.id, c.task_id
         FROM agent_claims c
         JOIN agent_tasks t ON t.id = c.task_id
         WHERE t.project_id = ? AND c.released_at IS NULL
           AND c.expires_at <= ?
           AND t.status IN ('claimed', 'running', 'waiting')`,
      )
      .all(projectId, new Date().toISOString()) as Array<{
      id: string;
      task_id: string;
    }>;
    if (expired.length === 0) return;
    const now = new Date().toISOString();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const release = this.#database.prepare(
        'UPDATE agent_claims SET released_at = ? WHERE id = ? AND released_at IS NULL',
      );
      const requeue = this.#database.prepare(
        `UPDATE agent_tasks SET status = 'queued', updated_at = ?
         WHERE id = ? AND status IN ('claimed', 'running', 'waiting')`,
      );
      const receipt = this.#database.prepare(
        `INSERT OR IGNORE INTO task_receipts
         (id, task_id, result, summary, created_at, idempotency_key,
          project_revision, detail_json)
         VALUES (?, ?, 'interrupted', 'Agent claim expired; task is reclaimable',
                 ?, ?, NULL, '{}')`,
      );
      expired.forEach((claim) => {
        release.run(now, claim.id);
        requeue.run(now, claim.task_id);
        receipt.run(
          randomUUID(),
          claim.task_id,
          now,
          `interrupted:${claim.id}`,
        );
      });
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  editLedger(input: {
    actor: Actor;
    expectedRevision: number;
    operation: LedgerOperation;
    projectId: string;
  }): LedgerProjectSnapshot {
    assertAuthorized(input.actor, 'change_shots');
    const current = this.#currentLedger(input.projectId);
    let next = current.shots.map((shot) => ({ ...shot }));
    const newEntities = new Set<string>();
    const ancestry: Array<{
      childShotId: string;
      parentShotId: string;
      relation: string;
    }> = [];

    switch (input.operation.kind) {
      case 'reorder': {
        if (
          input.operation.shotIds.length !== next.length ||
          new Set(input.operation.shotIds).size !== next.length ||
          input.operation.shotIds.some(
            (id) => !next.some((shot) => shot.id === id),
          )
        ) {
          throw new StoreError(
            'INVALID_INPUT',
            'Reorder must include every current shot once',
          );
        }
        const byId = new Map(next.map((shot) => [shot.id, shot]));
        next = input.operation.shotIds.map((id) => ({ ...byId.get(id)! }));
        break;
      }
      case 'cut': {
        const operation = input.operation;
        if (next.length === 1) {
          throw new StoreError(
            'INVALID_INPUT',
            'A ledger must retain at least one shot',
          );
        }
        const before = next.length;
        next = next.filter((shot) => shot.id !== operation.shotId);
        if (next.length === before)
          throw new StoreError('NOT_FOUND', 'Shot was not found');
        break;
      }
      case 'trim': {
        const operation = input.operation;
        const shot = next.find(
          (candidate) => candidate.id === operation.shotId,
        );
        if (
          !shot ||
          operation.startWordOrdinal < shot.startWordOrdinal ||
          operation.endWordOrdinal > shot.endWordOrdinal ||
          operation.endWordOrdinal < operation.startWordOrdinal
        ) {
          throw new StoreError(
            'INVALID_INPUT',
            'Trim range must stay inside the shot',
          );
        }
        const words = this.#wordsForTranscript(
          this.#currentEditorialTranscript(input.projectId).id,
        );
        shot.startWordOrdinal = operation.startWordOrdinal;
        shot.endWordOrdinal = operation.endWordOrdinal;
        shot.first_word_id = words[shot.startWordOrdinal]!.id;
        shot.last_word_id = words[shot.endWordOrdinal]!.id;
        break;
      }
      case 'split': {
        const operation = input.operation;
        const index = next.findIndex((shot) => shot.id === operation.shotId);
        const shot = next[index];
        if (
          !shot ||
          operation.atWordOrdinal <= shot.startWordOrdinal ||
          operation.atWordOrdinal > shot.endWordOrdinal
        ) {
          throw new StoreError(
            'INVALID_INPUT',
            'Split boundary must be inside the shot',
          );
        }
        const words = this.#wordsForTranscript(
          this.#currentEditorialTranscript(input.projectId).id,
        );
        const leftId = randomUUID();
        const rightId = randomUUID();
        newEntities.add(leftId);
        newEntities.add(rightId);
        next.splice(
          index,
          1,
          {
            ...shot,
            endWordOrdinal: operation.atWordOrdinal - 1,
            id: leftId,
            last_word_id: words[operation.atWordOrdinal - 1]!.id,
            theme: `${shot.theme} A`,
          },
          {
            ...shot,
            first_word_id: words[operation.atWordOrdinal]!.id,
            id: rightId,
            startWordOrdinal: operation.atWordOrdinal,
            theme: `${shot.theme} B`,
          },
        );
        ancestry.push(
          { childShotId: leftId, parentShotId: shot.id, relation: 'split' },
          { childShotId: rightId, parentShotId: shot.id, relation: 'split' },
        );
        break;
      }
      case 'merge': {
        const operation = input.operation;
        const leftIndex = next.findIndex(
          (shot) => shot.id === operation.leftShotId,
        );
        const rightIndex = next.findIndex(
          (shot) => shot.id === operation.rightShotId,
        );
        const left = next[leftIndex];
        const right = next[rightIndex];
        if (
          !left ||
          !right ||
          rightIndex !== leftIndex + 1 ||
          left.endWordOrdinal + 1 !== right.startWordOrdinal
        ) {
          throw new StoreError(
            'INVALID_INPUT',
            'Only adjacent source-contiguous shots can be merged',
          );
        }
        const id = randomUUID();
        newEntities.add(id);
        next.splice(leftIndex, 2, {
          ...left,
          endWordOrdinal: right.endWordOrdinal,
          id,
          last_word_id: right.last_word_id,
          rationale: `${left.rationale} ${right.rationale}`.trim(),
          theme: `${left.theme} + ${right.theme}`,
        });
        ancestry.push(
          { childShotId: id, parentShotId: left.id, relation: 'merge' },
          { childShotId: id, parentShotId: right.id, relation: 'merge' },
        );
        break;
      }
    }
    next.forEach((shot, ordinal) => {
      shot.ordinal = ordinal;
    });
    this.#writeLedgerSnapshot({
      actor: input.actor,
      ancestry,
      expectedRevision: input.expectedRevision,
      newEntities,
      operationDetail: input.operation,
      projectId: input.projectId,
      shots: next,
    });
    return this.getLedgerProject(input.projectId);
  }

  createLedgerCheckpoint(input: {
    actor: Actor;
    expectedRevision: number;
    name: string;
    projectId: string;
  }): { id: string; name: string; revision: number } {
    if (input.actor.kind !== 'human') {
      throw new StoreError('FORBIDDEN', 'Only humans can create checkpoints');
    }
    const project = this.getProject(input.projectId);
    if (project.revision !== input.expectedRevision) {
      throw new StoreError('REVISION_CONFLICT', 'Checkpoint revision is stale');
    }
    this.#currentLedger(input.projectId);
    const id = randomUUID();
    const name = input.name.trim();
    if (!name)
      throw new StoreError('INVALID_INPUT', 'Checkpoint name is required');
    this.#database
      .prepare(
        `INSERT INTO checkpoints (id, project_id, revision, name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        project.revision,
        name,
        new Date().toISOString(),
      );
    return { id, name, revision: project.revision };
  }

  restoreLedgerCheckpoint(input: {
    actor: Actor;
    checkpointId: string;
    expectedRevision: number;
    projectId: string;
  }): LedgerProjectSnapshot {
    assertAuthorized(input.actor, 'change_shots');
    const checkpoint = this.#database
      .prepare(
        `SELECT revision FROM checkpoints WHERE id = ? AND project_id = ?`,
      )
      .get(input.checkpointId, input.projectId) as
      { revision: number } | undefined;
    if (!checkpoint)
      throw new StoreError('NOT_FOUND', 'Checkpoint was not found');
    const sequence = this.#database
      .prepare(
        `SELECT id FROM edit_sequences
         WHERE project_id = ? AND revision <= ?
         ORDER BY revision DESC LIMIT 1`,
      )
      .get(input.projectId, checkpoint.revision) as { id: string } | undefined;
    if (!sequence)
      throw new StoreError('NOT_FOUND', 'Checkpoint has no ledger state');
    return this.#restoreLedgerSequence({
      actor: input.actor,
      expectedRevision: input.expectedRevision,
      projectId: input.projectId,
      sequenceId: sequence.id,
      source: 'checkpoint',
    });
  }

  undoLedger(input: {
    actor: Actor;
    expectedRevision: number;
    projectId: string;
  }): LedgerProjectSnapshot {
    assertAuthorized(input.actor, 'change_shots');
    const sequences = this.#database
      .prepare(
        `SELECT id FROM edit_sequences WHERE project_id = ?
         ORDER BY revision DESC LIMIT 2`,
      )
      .all(input.projectId) as Array<{ id: string }>;
    if (sequences.length < 2)
      throw new StoreError('INVALID_INPUT', 'Nothing to undo');
    return this.#restoreLedgerSequence({
      actor: input.actor,
      expectedRevision: input.expectedRevision,
      projectId: input.projectId,
      sequenceId: sequences[1]!.id,
      source: 'undo',
    });
  }

  getLedgerProject(projectId: string): LedgerProjectSnapshot {
    const project = this.getProject(projectId);
    const current = this.#currentLedger(projectId);
    const ancestry = this.#database
      .prepare(
        `SELECT child_shot_id AS childShotId,
                parent_shot_id AS parentShotId, relation
         FROM shot_ancestry`,
      )
      .all() as LedgerProjectSnapshot['ancestry'];
    const checkpoints = this.#database
      .prepare(
        `SELECT id, name, revision FROM checkpoints
         WHERE project_id = ? ORDER BY created_at, rowid`,
      )
      .all(projectId) as LedgerProjectSnapshot['checkpoints'];
    const history = this.#database
      .prepare(
        `SELECT actor_id AS actorId, actor_kind AS actorKind,
                operation, revision
         FROM change_events WHERE project_id = ?
         ORDER BY revision DESC LIMIT 100`,
      )
      .all(projectId) as LedgerProjectSnapshot['history'];
    return {
      ...project,
      ancestry,
      checkpoints,
      history,
      shots: current.shots.map(
        ({
          endWordOrdinal,
          id,
          ordinal,
          rationale,
          startWordOrdinal,
          theme,
        }) => ({
          endWordOrdinal,
          id,
          ordinal,
          rationale,
          startWordOrdinal,
          theme,
        }),
      ),
    };
  }

  #currentLedger(projectId: string): {
    sequenceId: string;
    shots: LedgerVersionRow[];
  } {
    const sequence = this.#database
      .prepare(
        `SELECT id FROM edit_sequences WHERE project_id = ?
         ORDER BY revision DESC LIMIT 1`,
      )
      .get(projectId) as { id: string } | undefined;
    if (!sequence)
      throw new StoreError('INVALID_INPUT', 'Accept a shot proposal first');
    const shots = this.#database
      .prepare(
        `SELECT v.shot_id AS id, v.ordinal, v.theme, v.rationale,
                v.first_word_id, v.last_word_id,
                first_word.ordinal AS startWordOrdinal,
                last_word.ordinal AS endWordOrdinal
         FROM shot_versions v
         JOIN transcript_words first_word ON first_word.id = v.first_word_id
         JOIN transcript_words last_word ON last_word.id = v.last_word_id
         WHERE v.edit_sequence_id = ? ORDER BY v.ordinal`,
      )
      .all(sequence.id) as LedgerVersionRow[];
    return { sequenceId: sequence.id, shots };
  }

  #writeLedgerSnapshot(input: {
    actor: Actor;
    ancestry: Array<{
      childShotId: string;
      parentShotId: string;
      relation: string;
    }>;
    expectedRevision: number;
    newEntities: Set<string>;
    operationDetail: unknown;
    projectId: string;
    shots: LedgerVersionRow[];
  }): void {
    const sequenceId = randomUUID();
    this.#commitIntakeRevision({
      actor: input.actor,
      expectedRevision: input.expectedRevision,
      operation: 'change_shots',
      payload: { edit: input.operationDetail },
      projectId: input.projectId,
      write: (revision, now) => {
        this.#database
          .prepare(
            `INSERT INTO edit_sequences (id, project_id, revision, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(sequenceId, input.projectId, revision, now);
        const insertEntity = this.#database.prepare(
          `INSERT INTO shots
           (id, edit_sequence_id, ordinal, theme, created_at, rationale)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        const insertSpan = this.#database.prepare(
          `INSERT INTO shot_source_spans
           (id, shot_id, ordinal, first_word_id, last_word_id)
           VALUES (?, ?, 0, ?, ?)`,
        );
        const insertVersion = this.#database.prepare(
          `INSERT INTO shot_versions
           (edit_sequence_id, shot_id, ordinal, theme, rationale,
            first_word_id, last_word_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        input.shots.forEach((shot) => {
          if (input.newEntities.has(shot.id)) {
            insertEntity.run(
              shot.id,
              sequenceId,
              shot.ordinal,
              shot.theme,
              now,
              shot.rationale,
            );
            insertSpan.run(
              randomUUID(),
              shot.id,
              shot.first_word_id,
              shot.last_word_id,
            );
          }
          insertVersion.run(
            sequenceId,
            shot.id,
            shot.ordinal,
            shot.theme,
            shot.rationale,
            shot.first_word_id,
            shot.last_word_id,
          );
        });
        const insertAncestry = this.#database.prepare(
          `INSERT INTO shot_ancestry
           (child_shot_id, parent_shot_id, relation) VALUES (?, ?, ?)`,
        );
        input.ancestry.forEach((edge) =>
          insertAncestry.run(
            edge.childShotId,
            edge.parentShotId,
            edge.relation,
          ),
        );
        return revision;
      },
    });
  }

  #restoreLedgerSequence(input: {
    actor: Actor;
    expectedRevision: number;
    projectId: string;
    sequenceId: string;
    source: string;
  }): LedgerProjectSnapshot {
    const shots = this.#database
      .prepare(
        `SELECT v.shot_id AS id, v.ordinal, v.theme, v.rationale,
                v.first_word_id, v.last_word_id,
                first_word.ordinal AS startWordOrdinal,
                last_word.ordinal AS endWordOrdinal
         FROM shot_versions v
         JOIN transcript_words first_word ON first_word.id = v.first_word_id
         JOIN transcript_words last_word ON last_word.id = v.last_word_id
         WHERE v.edit_sequence_id = ? ORDER BY v.ordinal`,
      )
      .all(input.sequenceId) as LedgerVersionRow[];
    this.#writeLedgerSnapshot({
      actor: input.actor,
      ancestry: [],
      expectedRevision: input.expectedRevision,
      newEntities: new Set(),
      operationDetail: {
        source: input.source,
        sourceSequenceId: input.sequenceId,
      },
      projectId: input.projectId,
      shots,
    });
    return this.getLedgerProject(input.projectId);
  }

  getEditorialProject(projectId: string): EditorialProjectSnapshot {
    const project = this.getProject(projectId);
    const raw = this.#database
      .prepare(
        `SELECT id, revision, attempt_id FROM transcript_revisions
         WHERE project_id = ? AND kind = 'provider'
         ORDER BY revision DESC LIMIT 1`,
      )
      .get(projectId) as EditorialTranscriptRow | undefined;
    const effective = this.#currentEditorialTranscript(projectId);
    if (!raw) throw new StoreError('INVALID_INPUT', 'A transcript is required');
    const proposals = this.#database
      .prepare(
        `SELECT id, task_id, status, pacing, constraints_json, base_revision,
                base_transcript_revision_id
         FROM editorial_proposals WHERE project_id = ?
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(projectId) as ProposalRow[];
    const tasks = this.#database
      .prepare(
        `SELECT id, status, instruction, base_revision
         FROM agent_tasks WHERE project_id = ?
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(projectId) as Array<{
      base_revision: number;
      id: string;
      instruction: string;
      status: string;
    }>;
    const sequence = this.#database
      .prepare(
        `SELECT id FROM edit_sequences WHERE project_id = ?
         ORDER BY revision DESC LIMIT 1`,
      )
      .get(projectId) as { id: string } | undefined;
    const shotRows = sequence
      ? (this.#database
          .prepare(
            `SELECT s.shot_id AS id, s.ordinal, s.theme, s.rationale,
                    first_word.ordinal AS startWordOrdinal,
                    last_word.ordinal AS endWordOrdinal
             FROM shot_versions s
             JOIN transcript_words first_word ON first_word.id = s.first_word_id
             JOIN transcript_words last_word ON last_word.id = s.last_word_id
             WHERE s.edit_sequence_id = ? ORDER BY s.ordinal`,
          )
          .all(sequence.id) as EditorialProjectSnapshot['shots'])
      : [];
    const checkpoints = this.#database
      .prepare(
        `SELECT id, name, revision FROM checkpoints
         WHERE project_id = ? ORDER BY created_at, rowid`,
      )
      .all(projectId) as EditorialProjectSnapshot['checkpoints'];
    return {
      ...project,
      checkpoints,
      effectiveTranscript: {
        id: effective.id,
        revision: effective.revision,
        words: this.#wordsForTranscript(effective.id),
      },
      proposals: proposals.map((proposal) => ({
        baseProjectRevision: proposal.base_revision,
        baseTranscriptRevisionId: proposal.base_transcript_revision_id,
        constraints: JSON.parse(proposal.constraints_json) as Record<
          string,
          unknown
        >,
        id: proposal.id,
        pacing: proposal.pacing,
        shots: (
          this.#database
            .prepare(
              `SELECT payload_json FROM proposal_operations
               WHERE proposal_id = ? ORDER BY ordinal`,
            )
            .all(proposal.id) as Array<{ payload_json: string }>
        ).map(
          ({ payload_json }) =>
            JSON.parse(payload_json) as {
              endWordOrdinal: number;
              rationale: string;
              startWordOrdinal: number;
              theme: string;
            },
        ),
        status: proposal.status,
        taskId: proposal.task_id,
      })),
      rawTranscript: {
        id: raw.id,
        revision: raw.revision,
        words: this.#wordsForTranscript(raw.id),
      },
      shots: shotRows,
      tasks: tasks.map((task) => ({
        baseRevision: task.base_revision,
        id: task.id,
        instruction: task.instruction,
        status: task.status,
      })),
    };
  }

  #currentEditorialTranscript(projectId: string): EditorialTranscriptRow {
    const current = this.#database
      .prepare(
        `SELECT id, revision, attempt_id FROM transcript_revisions
         WHERE project_id = ? ORDER BY revision DESC LIMIT 1`,
      )
      .get(projectId) as EditorialTranscriptRow | undefined;
    if (!current)
      throw new StoreError('INVALID_INPUT', 'A transcript is required');
    return current;
  }

  #wordsForTranscript(
    transcriptId: string,
  ): EditorialProjectSnapshot['effectiveTranscript']['words'] {
    return this.#database
      .prepare(
        `SELECT id, ordinal, text, start_ms AS startMs, end_ms AS endMs
         FROM transcript_words WHERE transcript_revision_id = ? ORDER BY ordinal`,
      )
      .all(
        transcriptId,
      ) as EditorialProjectSnapshot['effectiveTranscript']['words'];
  }

  #proposal(projectId: string, proposalId: string): ProposalRow {
    const proposal = this.#database
      .prepare(
        `SELECT id, task_id, status, pacing, constraints_json, base_revision,
                base_transcript_revision_id
         FROM editorial_proposals WHERE id = ? AND project_id = ?`,
      )
      .get(proposalId, projectId) as ProposalRow | undefined;
    if (!proposal) throw new StoreError('NOT_FOUND', 'Proposal was not found');
    return proposal;
  }

  #assertExactShotCoverage(
    shots: Array<{
      endWordOrdinal: number;
      rationale: string;
      startWordOrdinal: number;
      theme: string;
    }>,
    wordCount: number,
  ): void {
    if (shots.length === 0) {
      throw new StoreError(
        'INVALID_PROPOSAL',
        'Proposal must contain at least one shot',
      );
    }
    let expectedStart = 0;
    for (const [index, shot] of shots.entries()) {
      if (
        shot.startWordOrdinal !== expectedStart ||
        !Number.isInteger(shot.endWordOrdinal) ||
        shot.endWordOrdinal < shot.startWordOrdinal ||
        shot.endWordOrdinal >= wordCount ||
        !shot.theme.trim() ||
        !shot.rationale.trim()
      ) {
        throw new StoreError(
          'INVALID_PROPOSAL',
          `Shot ${index + 1} does not preserve exact chronological coverage`,
        );
      }
      expectedStart = shot.endWordOrdinal + 1;
    }
    if (expectedStart !== wordCount) {
      throw new StoreError(
        'INVALID_PROPOSAL',
        'Proposal does not cover every transcript word',
      );
    }
  }

  subscribe(listener: (event: ProjectEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  issueCredential(input: { role: ActorKind; scopes: string[] }): Credential {
    const token = randomBytes(32).toString('base64url');
    this.#database
      .prepare(
        `INSERT INTO credentials
         (token_hash, role, scopes_json, revoked_at, created_at)
         VALUES (?, ?, ?, NULL, ?)`,
      )
      .run(
        hashToken(token),
        input.role,
        JSON.stringify(input.scopes),
        new Date().toISOString(),
      );
    return { ...input, token };
  }

  authenticate(token: string): {
    actor: Actor;
    credentialHash: string;
    scopes: string[];
  } {
    const tokenHash = hashToken(token);
    const row = this.#database
      .prepare(
        'SELECT role, scopes_json, revoked_at FROM credentials WHERE token_hash = ?',
      )
      .get(tokenHash) as CredentialRow | undefined;
    if (!row || row.revoked_at) {
      throw new StoreError('UNAUTHORIZED', 'Credential is missing or revoked');
    }
    return {
      actor: { id: tokenHash.slice(0, 16), kind: row.role },
      credentialHash: tokenHash,
      scopes: JSON.parse(row.scopes_json) as string[],
    };
  }

  revokeCredential(token: string): void {
    const result = this.#database
      .prepare('UPDATE credentials SET revoked_at = ? WHERE token_hash = ?')
      .run(new Date().toISOString(), hashToken(token));
    if (result.changes === 0)
      throw new StoreError('NOT_FOUND', 'Credential not found');
  }
}

export function openProjectStore(
  databasePath: string,
  options: StoreOptions = {},
): ProjectStore {
  return new ProjectStore(databasePath, options);
}
