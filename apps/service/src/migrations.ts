import type BetterSqlite3 from 'better-sqlite3';

const migrationOne = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL
);
CREATE TABLE project_revisions (
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, revision)
);
CREATE TABLE credentials (
  token_hash TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('human', 'agent')),
  scopes_json TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE source_audio (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  managed_path TEXT NOT NULL,
  checksum TEXT NOT NULL,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE transcription_attempts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  raw_artifact_path TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE transcript_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  attempt_id TEXT REFERENCES transcription_attempts(id),
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE transcript_words (
  id TEXT PRIMARY KEY,
  transcript_revision_id TEXT NOT NULL REFERENCES transcript_revisions(id),
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL
);
CREATE TABLE transcript_corrections (
  id TEXT PRIMARY KEY,
  transcript_revision_id TEXT NOT NULL REFERENCES transcript_revisions(id),
  first_word_id TEXT NOT NULL,
  last_word_id TEXT NOT NULL,
  replacement_text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE edit_sequences (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE shots (
  id TEXT PRIMARY KEY,
  edit_sequence_id TEXT NOT NULL REFERENCES edit_sequences(id),
  ordinal INTEGER NOT NULL,
  theme TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE shot_source_spans (
  id TEXT PRIMARY KEY,
  shot_id TEXT NOT NULL REFERENCES shots(id),
  ordinal INTEGER NOT NULL,
  first_word_id TEXT NOT NULL,
  last_word_id TEXT NOT NULL
);
CREATE TABLE shot_ancestry (
  child_shot_id TEXT NOT NULL REFERENCES shots(id),
  parent_shot_id TEXT NOT NULL REFERENCES shots(id),
  relation TEXT NOT NULL,
  PRIMARY KEY (child_shot_id, parent_shot_id)
);
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE asset_files (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  managed_path TEXT NOT NULL,
  checksum TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE asset_provenance (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  origin TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE shot_candidates (
  shot_id TEXT NOT NULL REFERENCES shots(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (shot_id, asset_id)
);
CREATE TABLE shot_selections (
  shot_id TEXT PRIMARY KEY REFERENCES shots(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  selected_by TEXT NOT NULL,
  selected_at TEXT NOT NULL
);
CREATE TABLE format_overrides (
  id TEXT PRIMARY KEY,
  shot_id TEXT NOT NULL REFERENCES shots(id),
  format TEXT NOT NULL,
  fit TEXT NOT NULL,
  captions_enabled INTEGER NOT NULL,
  UNIQUE (shot_id, format)
);
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  credential_hash TEXT NOT NULL REFERENCES credentials(token_hash),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  base_revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  instruction TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE agent_claims (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id),
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  expires_at TEXT NOT NULL,
  released_at TEXT
);
CREATE TABLE task_receipts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id),
  result TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE editorial_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  base_revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE proposal_operations (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES editorial_proposals(id),
  ordinal INTEGER NOT NULL,
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE change_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE job_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE render_artifacts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  format TEXT NOT NULL,
  published_path TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const migrationTwo = `
ALTER TABLE source_audio ADD COLUMN original_name TEXT NOT NULL DEFAULT '';
ALTER TABLE source_audio ADD COLUMN mime_type TEXT NOT NULL DEFAULT '';
ALTER TABLE source_audio ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transcription_attempts ADD COLUMN error_message TEXT;
CREATE INDEX source_audio_project_created
  ON source_audio (project_id, created_at DESC);
CREATE INDEX transcription_attempts_project_created
  ON transcription_attempts (project_id, created_at DESC);
CREATE INDEX transcript_revisions_project_revision
  ON transcript_revisions (project_id, revision DESC);
`;

const migrationThree = `
ALTER TABLE transcript_revisions ADD COLUMN kind TEXT NOT NULL DEFAULT 'provider';
ALTER TABLE transcript_revisions ADD COLUMN base_transcript_revision_id TEXT;
ALTER TABLE editorial_proposals ADD COLUMN task_id TEXT REFERENCES agent_tasks(id);
ALTER TABLE editorial_proposals ADD COLUMN base_transcript_revision_id TEXT;
ALTER TABLE editorial_proposals ADD COLUMN pacing TEXT NOT NULL DEFAULT 'Standard';
ALTER TABLE editorial_proposals ADD COLUMN constraints_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE shots ADD COLUMN rationale TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_tasks ADD COLUMN pacing TEXT NOT NULL DEFAULT 'Standard';
ALTER TABLE agent_tasks ADD COLUMN constraints_json TEXT NOT NULL DEFAULT '{}';
CREATE INDEX editorial_proposals_project_created
  ON editorial_proposals (project_id, created_at DESC);
CREATE INDEX agent_tasks_project_created
  ON agent_tasks (project_id, created_at DESC);
`;

const migrationFour = `
CREATE TABLE shot_versions (
  edit_sequence_id TEXT NOT NULL REFERENCES edit_sequences(id),
  shot_id TEXT NOT NULL REFERENCES shots(id),
  ordinal INTEGER NOT NULL,
  theme TEXT NOT NULL,
  rationale TEXT NOT NULL,
  first_word_id TEXT NOT NULL,
  last_word_id TEXT NOT NULL,
  PRIMARY KEY (edit_sequence_id, shot_id),
  UNIQUE (edit_sequence_id, ordinal)
);
INSERT INTO shot_versions
  (edit_sequence_id, shot_id, ordinal, theme, rationale, first_word_id, last_word_id)
SELECT s.edit_sequence_id, s.id, s.ordinal, s.theme, s.rationale,
       span.first_word_id, span.last_word_id
FROM shots s
JOIN shot_source_spans span ON span.shot_id = s.id;
CREATE INDEX shot_versions_sequence_ordinal
  ON shot_versions (edit_sequence_id, ordinal);
`;

const migrationFive = `
ALTER TABLE agent_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'proposal';
ALTER TABLE agent_tasks ADD COLUMN target_shot_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agent_tasks ADD COLUMN result_revision INTEGER;
ALTER TABLE agent_tasks ADD COLUMN updated_at TEXT;
ALTER TABLE agent_claims ADD COLUMN heartbeat_at TEXT;
ALTER TABLE task_receipts ADD COLUMN idempotency_key TEXT;
ALTER TABLE task_receipts ADD COLUMN project_revision INTEGER;
ALTER TABLE task_receipts ADD COLUMN detail_json TEXT NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX task_receipts_task_idempotency
  ON task_receipts (task_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
`;

const migrationSix = `
CREATE TABLE shot_candidate_recommendations (
  shot_id TEXT NOT NULL REFERENCES shots(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  agent_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (shot_id, asset_id, agent_id)
);
`;

const migrationSeven = `
ALTER TABLE agent_tasks ADD COLUMN parent_task_id TEXT REFERENCES agent_tasks(id);
`;

const migrationEight = `
ALTER TABLE jobs ADD COLUMN updated_at TEXT;
ALTER TABLE jobs ADD COLUMN error_message TEXT;
ALTER TABLE jobs ADD COLUMN allow_placeholders INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN output_formats_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE jobs ADD COLUMN plan_json TEXT;
ALTER TABLE jobs ADD COLUMN parent_job_id TEXT REFERENCES jobs(id);
ALTER TABLE job_attempts ADD COLUMN idempotency_key TEXT;
ALTER TABLE render_artifacts ADD COLUMN width INTEGER NOT NULL DEFAULT 0;
ALTER TABLE render_artifacts ADD COLUMN height INTEGER NOT NULL DEFAULT 0;
ALTER TABLE render_artifacts ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX job_attempts_job_idempotency
  ON job_attempts (job_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
`;

export function applyMigrations(database: BetterSqlite3.Database): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const migrations = [
    { sql: migrationOne, version: 1 },
    { sql: migrationTwo, version: 2 },
    { sql: migrationThree, version: 3 },
    { sql: migrationFour, version: 4 },
    { sql: migrationFive, version: 5 },
    { sql: migrationSix, version: 6 },
    { sql: migrationSeven, version: 7 },
    { sql: migrationEight, version: 8 },
  ];
  for (const migration of migrations) {
    const applied = database
      .prepare('SELECT 1 FROM migrations WHERE version = ?')
      .get(migration.version);
    if (applied) continue;
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(migration.sql);
      database
        .prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}
