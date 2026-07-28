# Rant Studio

Rant Studio is a local-first TypeScript workbench for turning one narration
track into a shot-based commentary video with a human and an external CLI
agent. The browser and CLI share one revisioned SQLite project; agents may
propose and attach work, while the service reserves editorial acceptance,
active visuals, output settings, and incomplete export for the human.

The default route remains the approved deterministic UX prototype. The working
production application is at `/?mode=intake`.

## Requirements

- Node.js 22 or newer
- npm
- FFmpeg and ffprobe on `PATH`

Verify them with `node --version`, `ffmpeg -version`, and `ffprobe -version`.

## Install and run

```bash
npm install
npm run service
```

The service binds to `127.0.0.1`, creates `.rant-studio/`, and prints its local
URL plus separate human and agent credentials. Leave it running.

In a second terminal:

```bash
npm run dev
```

Open `http://rant-studio.localhost:4173/?mode=intake`, enter the printed service URL and
human credential, then choose **Connect**.

For an external agent CLI:

```bash
export RANT_STUDIO_URL=http://127.0.0.1:4174
export RANT_STUDIO_CREDENTIAL='<printed agent credential>'
npm run rant -- help
```

The CLI help names every required project, task, revision, and target argument,
plus recovery for stale revisions and interrupted claims. Do not give an agent
the human credential.

## Fresh project walkthrough

No JSON or SQLite editing is required:

1. Create a project in the browser.
2. Upload a RIFF/WAVE narration file.
3. Choose **Transcribe deterministically**. Timestamp JSON import is optional.
4. Open editorial, correct a timestamped word if needed, and queue a
   revision-bound shot-planning task. In the external CLI, attach an agent,
   claim that task, and use `proposal submit-chronological`; the browser never
   receives the agent credential and updates when the result arrives.
5. Review, adjust, reject/regenerate, and explicitly accept the staged result.
6. Open the Production Shot Ledger to reorder, split, merge, cut, checkpoint,
   undo, or restore.
7. Upload PNG/MP4 candidates or dispatch an explicitly targeted CLI task.
   Only the human can select the active visual.
8. Open preview/export, play a revision-bound individual shot and assembled
   edit, inspect preflight, set independent 16:9/9:16 fit and captions, and
   authorize any missing-visual placeholders.
9. Render and play the published 1920×1080 and 1080×1920 MP4 artifacts.
10. Inspect Activity receipts and History revisions.

## Data, backup, and recovery

By default, the SQLite database and checksum-addressed managed media live under
`.rant-studio/`. Stop the service before copying that entire directory for a
consistent backup. Restore by replacing the directory while the service is
stopped, then restart. Never copy only the SQLite file without its `media/`
tree.

Optional local configuration:

- `RANT_STUDIO_DATA_DIR` — database and managed-media root
- `RANT_STUDIO_IMPORT_ROOT` — only directory from which CLI path imports may
  read
- `RANT_STUDIO_PORT` — loopback port, default `4174`

On restart, accepted edits, credentials, selections, receipts, jobs, and
artifacts remain in SQLite. An interrupted running render becomes `waiting` and
can be retried; expired agent claims become reclaimable. Failed or canceled
renders never replace a prior successful artifact.

## Provider boundary and privacy

V1 includes a deterministic transcription adapter and validated timestamp JSON
import. A real OpenAI/Grok adapter belongs behind
`packages/transcription/src/index.ts`; keep provider keys in the process
environment. Credential- or secret-shaped values are rejected from project
history. The service is loopback-only and does not publish to YouTube, search
the web, or call image/video generation providers.

## Verification

Run the complete owned release oracle:

```bash
npm run test:release
```

Individual gates include `npm run check`, `npm run build`,
`npm run test:e2e`, `npm run test:performance`, `npm run test:media`, and
`npm run test:a11y`.

## Continuous integration

GitHub Actions runs the same release contract for pull requests and merge-queue
groups on Node.js 24. The workflow separates quality, build, Node/media, and
Playwright work so failures are attributable, then reports one stable required
status named **CI Gate**.

The quality job blocks on ESLint, Prettier, TypeScript, production Knip, and a
maximum-lines ratchet. New production files are limited to 500 lines and new
test files to 650 lines. Oversized V1 files have explicit frozen ceilings in
`scripts/check-max-lines.mjs`; they may shrink but may not grow while they are
split into smaller modules.

Failed Playwright runs retain traces, screenshots, and the HTML report as a
GitHub Actions artifact. Run `npm ci && npm run test:release` before pushing to
reproduce the complete CI contract locally.

## Troubleshooting and limitations

- `REVISION_CONFLICT`: refresh the browser/CLI view and retry with the current
  revision. Open preflight must be rechecked after any project change.
- `DETACHED_AGENT` or an interrupted task: attach again, then reclaim the queued
  task.
- `PREFLIGHT_BLOCKED`: restore readable narration/selected media or correct an
  invalid shot range.
- FFmpeg errors: confirm both FFmpeg and ffprobe are on `PATH`; the last valid
  artifact remains untouched.
- V1 accepts WAV narration and PNG/MP4 visuals. It has one local creator, hard
  cuts, deterministic local rendering, and no hosted collaboration, recording,
  web search, generation provider, YouTube publishing, or mobile-native app.

More operational detail is in
[`docs/operator/README.md`](docs/operator/README.md).
