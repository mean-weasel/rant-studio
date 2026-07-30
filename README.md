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
URL plus a restricted credential for external agents. The local owner app and
owner-operated CLI connect automatically without a startup token. Leave the
service running.

The default transcription provider is a two-word deterministic fixture for
offline development. For real word timestamps, start the service with one of:

```bash
# Option 1: copy .env.example to the ignored .env.local and edit it.
cp .env.example .env.local

# Option 2: configure the current shell directly.
# OpenAI Whisper (25 MB maximum input)
export RANT_STUDIO_TRANSCRIPTION_PROVIDER=openai
export OPENAI_API_KEY='<server-only key>'

# Groq Cloud Whisper
export RANT_STUDIO_TRANSCRIPTION_PROVIDER=groq
export GROQ_API_KEY='<server-only key>'

# Optional ISO-639-1 language hint, such as en
export RANT_STUDIO_TRANSCRIPTION_LANGUAGE=en

npm run service
```

Provider credentials can stay in the service environment or be persisted in
macOS Keychain. They are never returned to the browser or CLI agent, project
history, or transcript artifact. Rant Studio uploads the preserved source file
to the selected provider so compressed MP3 and MP4 narration does not expand
into the larger PCM working copy first.

For persistent local QA, the owner CLI needs only the printed loopback URL:

```bash
export RANT_STUDIO_URL=http://127.0.0.1:4174
npm run rant -- provider configure openai
npm run rant -- provider test openai
```

The configure command uses a hidden prompt and stores the key in macOS
Keychain. Add `--stdin` only for non-interactive automation. The raw key is
never accepted as an argument or returned by the service. `provider list
--json` is safe for agents. Owner commands run locally without a credential;
configure, test, select, and remove reject explicitly credentialed agent
sessions. Environment configuration remains the highest-precedence
temporary/CI override.

In a second terminal:

```bash
npm run dev
```

Open `http://rant-studio.localhost:4173/?mode=intake`. The local owner app
connects automatically.

For an external agent CLI:

```bash
export RANT_STUDIO_URL=http://127.0.0.1:4174
export RANT_STUDIO_CREDENTIAL='<printed agent credential>'
npm run rant -- help
```

The CLI help names every required project, task, revision, and target argument,
plus recovery for stale revisions and interrupted claims. External agents
should always use the printed restricted agent credential.

## Fresh project walkthrough

No JSON or SQLite editing is required:

1. Create a project in the browser.
2. Upload WAV or MP3 narration, or an MP4 video with an audio stream. Rant
   Studio preserves the original and creates a managed PCM WAV working copy.
3. Choose **Transcribe narration**. Timestamp JSON import is optional.
4. Open editorial, correct a timestamped word if needed, and queue a
   revision-bound shot-planning task. In the external CLI, attach an agent,
   claim that task, inspect it with `proposal context`, author a semantic
   proposal file, and submit it with `proposal submit --revision <n>
--transcript <id> --shots-file <file>`; the browser never receives the agent
   credential and updates when the result arrives.
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

V1 includes deterministic, OpenAI Whisper, and Groq Cloud Whisper adapters plus
validated timestamp JSON import. OpenAI uses `whisper-1`; Groq uses
`whisper-large-v3-turbo`. Both request word timestamps required by the editing
pipeline. Keep provider keys in macOS Keychain or the service environment.
Credential- or secret-shaped values are rejected from project history. The
service is loopback-only and does not publish to YouTube, search the web, or
call image/video generation providers.

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
- Provider startup errors: set the API key matching
  `RANT_STUDIO_TRANSCRIPTION_PROVIDER`. OpenAI rejects inputs over 25 MB; use a
  compressed narration source or select Groq, whose plan-specific upload limit
  is enforced by its API.
- V1 accepts WAV/MP3/MP4 narration and PNG/MP4 visuals. It has one local creator, hard
  cuts, deterministic local rendering, and no hosted collaboration, recording,
  web search, generation provider, YouTube publishing, or mobile-native app.

More operational detail is in
[`docs/operator/README.md`](docs/operator/README.md).
