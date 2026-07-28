# Rant Studio operator guide

## Service lifecycle

Start with `npm run service`. The process opens the versioned SQLite store,
applies only additive migrations, reclassifies interrupted render jobs as
`waiting`, and listens only on `127.0.0.1`. Stop with Ctrl-C so HTTP and SQLite
close cleanly.

Treat the printed credentials as local secrets. Human credentials have
protected mutation authority; agent credentials are intentionally restricted.
Revoke or rotate credentials by creating a new local data root until a
credential-management screen is added.

Narration intake accepts WAV, MP3, and MP4 files. MP4 narration must contain a
decodable audio stream. The original file is retained under managed project
media, while transcription, preview, and rendering use a normalized 48 kHz PCM
WAV derivative.

## Backup and restore

1. Stop the service.
2. Copy the complete `RANT_STUDIO_DATA_DIR` (default `.rant-studio/`) to the
   backup destination.
3. Restore the complete directory, including `media/`, while stopped.
4. Start the service and run the release oracle against a disposable fixture
   before resuming important work.

SQLite WAL files may exist while the service is running, so a live copy is not
the supported backup method.

## Failure recovery

- Expired agent claims are released with an append-only interrupted receipt.
- Running renders found during startup become `waiting`; retry creates a new
  lineage-linked job using the immutable original plan.
- A failed/canceled render leaves every successful artifact directory intact.
- Stale proposal, task, selection, format, and preflight mutations return a
  conflict instead of partially applying.
- Managed source, candidate, and artifact paths are rooted and validated;
  traversal, symlink imports, unsupported signatures, and partial copies fail
  closed.

## Release gate

`npm run test:release` runs shared-model, intake, asset, service, CLI, media,
browser, 150-shot performance, accessibility, and fresh-oracle tests. Do not
ship by substituting a narrower grep or by weakening deterministic thresholds.
