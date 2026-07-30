import type BetterSqlite3 from 'better-sqlite3';

export function recoverInterruptedWork(database: BetterSqlite3.Database): void {
  database
    .prepare(
      `UPDATE transcription_attempts
       SET status = 'failed',
           error_message = 'Service restarted before transcription completed'
       WHERE status = 'running'`,
    )
    .run();
  database
    .prepare(
      `UPDATE jobs
       SET status = 'waiting',
           error_message = 'Service restarted while render was running',
           updated_at = ?
       WHERE status = 'running'`,
    )
    .run(new Date().toISOString());
}
