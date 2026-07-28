# Rant Studio: Version-One Product and System Design

Date: 2026-07-27

## Summary

Rant Studio is a local-first, human-agent workspace for turning a recorded
commentary track into a simple YouTube video. The browser and external agent
sessions operate on one durable project state through the same local service.

Version one is a thin end-to-end slice:

1. Upload narration audio.
2. Transcribe it through the initial OpenAI adapter or import timestamped
   Rant Studio transcript JSON.
3. Review and correct the untouched transcript.
4. Explicitly ask an attached agent to propose chronological shots.
5. Review and accept the staged shot proposal.
6. Attach visual candidates through the browser or agent CLI.
7. Let the human select one primary visual per shot.
8. Preview and render 16:9 and 9:16 MP4 files.

The product is deliberately not a nonlinear video editor. Its primary object is
the shot: a piece of narration, its timing, its visual candidates, its selected
visual, and the attributed human-agent work that shaped it.

## Product Principles

### One shared creative state

The browser and CLI are equal clients of the same local service. An agent reads
the exact project revision, shots, assets, selections, and instructions visible
to the human. Agent-created candidates return to that state, and human
selections become precise context for the next agent action.

### Raw by default

Importing or transcribing audio never segments, cuts, or rearranges it. The
creator begins with an untouched timestamped transcript. Agent involvement is
an explicit action.

### Additive agents, human editorial authority

Agents may directly add candidates, provenance, notes, and task results.
Transcript changes, shot boundaries or order, active asset selections, and
output settings are protected editorial state. Agent changes to protected state
are staged proposals until the human accepts them.

### Simple output, not layered composition

Each shot has one primary still image or video clip. Version one uses static
images, video playback from the beginning, hard cuts, and optional captions.
It does not expose layers, animated overlays, keyframes, or a freeform canvas.

### Durable context without duplicating chat

Rant Studio stores task receipts rather than mirroring an external agent's full
conversation. A receipt contains the instruction, target IDs, agent identity,
status, concise result, files added, proposals submitted, and timestamps.

## Intended User and Scale

Version one is for one creator working locally on 5–15 minute commentary
tracks. A representative project contains 40–150 shots.

The app should feel effortless at the acceptance fixture of a 15-minute audio
track and 150 shots. Multi-user collaboration, hosted projects, and hour-long
timeline optimization are outside version-one scope.

## Core Workflow

### 1. Create a project

The creator names a project and uploads an audio file. Rant Studio validates the
file, copies it into managed project media, computes a checksum, and extracts
basic metadata.

Audio is recorded outside Rant Studio in version one. There is no microphone or
recording UX.

### 2. Produce a timestamped transcript

The creator chooses one of two inputs:

- Transcribe through the initial OpenAI adapter.
- Import schema-versioned Rant Studio transcript JSON containing word-level
  timestamps.

The provider adapter stores the original provider response as an immutable
attempt artifact, then normalizes it into the Rant Studio transcript model.

The imported transcript opens unchanged. Users may correct transcription text.
Corrections retain links to the original words and timing spans and are visibly
identified as corrections. They do not modify the source audio.

### 3. Explicitly propose shots

The raw transcript view has a prominent **Propose shots** action. It is disabled
when no external agent session is attached and instead offers attach guidance.

The default control is a pacing preset:

| Preset | Target | Soft range |
| --- | ---: | ---: |
| Relaxed | 10 seconds | 6–15 seconds |
| Standard | 7 seconds | 4–12 seconds |
| Punchy | 4 seconds | 2–7 seconds |

Advanced controls may override target/minimum/maximum duration, maximum spoken
words, and approximate shot count. Explicit advanced values take precedence
over the preset. Duration and shot-count goals remain soft; valid source-word
boundaries and complete rhetorical thoughts take priority. A user-supplied
maximum word count is a hard ceiling.

The initial **Propose shots** action must partition the complete transcript in
chronological order. It may not remove or reorder narration. Later, separately
named agent tasks may propose cuts or reordering as protected editorial
changes.

The agent receives a context packet containing:

- Project and transcript revision IDs
- Ordered corrected transcript words and original timestamps
- Pacing and advanced constraints
- Whether visual briefs were requested
- Output formats enabled for the project

The agent returns proposed source ranges, concise themes, and reasons. A project
setting named **Include visual briefs in shot proposals** is off by default.
When enabled, the proposal also includes a visual-intent brief for each shot.

### 4. Review the staged proposal

The service validates that the proposal:

- Targets the revision the agent read
- Uses existing word boundaries
- Covers the full transcript exactly once
- Contains no overlapping ranges
- Preserves chronological order
- Obeys hard advanced constraints

The human sees the validated proposal without changing the project. They may
adjust boundaries, accept all, reject, or regenerate. Acceptance creates an
automatic checkpoint and applies the complete plan atomically.

If the transcript changes while the agent is working, the proposal is stale and
cannot be accepted without explicit reconciliation or regeneration.

### 5. Edit the sequence

The accepted shot list forms one linear narration edit. Users may:

- Adjust shot boundaries
- Split or merge shots
- Cut shots or source ranges
- Reorder shots
- Correct transcript text
- Restore an earlier checkpoint

Reordering shots also reorders their referenced narration audio in preview and
render output.

### 6. Attach and select visual assets

Each shot owns a candidate tray. Humans can upload image or video files from the
shot row. Agents can inspect current candidates and attach new files through the
CLI.

All intake paths copy bytes into managed media, compute checksums, extract
metadata, and record provenance. The database stores references and metadata,
not media blobs.

Candidates are nondestructive. Exactly zero or one candidate is active for a
shot and format. Agents may recommend candidates but cannot change the active
selection unless a future task explicitly extends their authority. In version
one, the human controls selection.

### 7. Preview and render

The main workspace does not reserve a persistent video player. Shot rows show
thumbnails and offer shot-level playback. The assembled preview opens on
demand.

Version one supports:

- 1920×1080 landscape output
- 1080×1920 vertical output

Both formats share narration order, shot timing, and the default selected
visual. Each format stores separate crop/fit, caption placement, and optional
replacement-asset overrides.

Landscape captions default off. Vertical captions default on. Captions have one
project-level style per format and may be overridden per shot when necessary.
Corrected transcript text is used for caption text while original timestamps
remain the timing source.

Visual treatment is intentionally literal:

- Still images remain static.
- Video clips begin at their start.
- A clip longer than its shot is trimmed.
- A clip shorter than its shot freezes on its final frame.
- Candidate-clip audio is muted by default.
- Hard cuts are the only default transition.
- Images and videos default to centered cover framing; users may switch a
  format override to contain.

Draft previews use an unmistakable placeholder frame for shots without an
active visual. Final export lists incomplete shots and requires explicit
confirmation to export with placeholders.

Successful output is H.264/AAC MP4 for both formats.

## Primary User Experience

### Application shell

The primary navigation is:

- **Edit** — transcript and Shot Ledger
- **Activity** — agent tasks, receipts, proposals, and background jobs
- **History** — attributed changes and named checkpoints
- **Settings** — transcription, shot-proposal defaults, captions, and local
  runtime details

The project header shows project name, duration, shot count, attached-agent
status, undo/redo, **Open preview**, and **Export**.

### Raw transcript state

Before shots exist, Edit shows the source transcript with audio transport,
word-timestamp-aware selection, corrections, and the explicit **Propose shots**
action. Pacing is approachable through the three presets; advanced controls are
collapsed by default.

### Shot Ledger

After shot acceptance, Edit becomes a full-width, vertically stacked Shot
Ledger. Each row has two primary columns:

**Narration**

- Stable shot ID and visible sequence number
- Source and edited time information
- Compact waveform and play control
- Correctable transcript text
- Split, trim, move, and overflow actions

**Visual**

- Candidate count and selection status
- Selected asset and alternate thumbnails
- Upload, inspect, detach, and provenance actions
- Per-format crop/fit status
- Clear missing-visual state

The ledger uses windowed rendering so projects near 150 shots remain responsive.
Incoming agent or job updates must not reset scroll position or discard
in-progress text.

### Selection-aware agent command dock

A persistent dock sits at the bottom of Edit. It contains:

- Explicit shot or multi-shot target chips
- Attached-session selector and connection state
- Deterministic action menu
- Natural-language instruction field
- Submission and task status

Row-level quick actions select the correct shot and prefill the dock rather than
duplicating full prompt controls in every row.

Instructions always store explicit project revision and shot IDs. The CLI never
relies on whichever shot happens to be selected in a browser.

### On-demand preview

Preview opens as a dedicated surface or dialog with:

- 16:9/9:16 switch
- Playback controls
- Current shot and source references
- Crop/fit and caption controls
- Preflight warnings
- Return-to-shot navigation

## Shared-State Architecture

Rant Studio is a TypeScript monorepo with four bounded runtime parts.

### Web client

The browser owns presentation and user interaction only. It renders the
transcript, Shot Ledger, proposal review, history, preview, and settings. It does
not directly edit SQLite or managed media.

### Local service

The local service is the sole authority for:

- Project reads and writes
- Revision and permission enforcement
- Managed media intake
- Proposal validation and application
- Linear history and checkpoints
- Agent claims and task receipts
- Transcription, preview, and render job orchestration

Browser and CLI use the same versioned API.

### Agent CLI and plugin

The CLI/plugin lets external agent sessions:

- Register against the local runtime
- Discover projects and current revisions
- Read scoped transcript, shot, asset, and task context
- Claim and heartbeat tasks
- Attach candidate assets with provenance
- Add notes and concise task results
- Submit protected changes as proposals
- Complete, fail, or release task claims

The web app does not spawn or own an LLM session. One or more external sessions
may attach; the user chooses the target session in the command dock. Claims
prevent two sessions from silently completing the same task.

### Media worker

Transcription, preview, and export are persistent background jobs. Worker
processes perform expensive work outside HTTP request handling and publish
progress to the local service.

The rendering boundary accepts a normalized timeline rather than project
internals. This keeps the initial MP4 implementation replaceable without
changing shot or asset state.

### Live updates

The browser subscribes to a lightweight service event stream. Events contain
revision IDs and affected entity IDs, causing targeted refetches rather than
shipping arbitrary database rows to clients.

## Data Model

The model is relational and schema-versioned.

### Source and transcript

- `Project`
- `SourceAudio`
- `TranscriptionAttempt`
- `TranscriptRevision`
- `TranscriptWord`
- `TranscriptCorrection`

The source audio and provider attempt artifacts are immutable. A correction
references the original word IDs and timing span.

### Edit and shots

- `EditSequence`
- `Shot`
- `ShotSourceSpan`
- `ShotAncestry`

A shot has a stable opaque ID independent of its visible ordinal. It references
one or more ordered, contiguous source-word spans. Boundary adjustments preserve
the shot ID. Split and merge operations create new IDs with ancestry links so
historical task targets remain explainable.

The first proposed plan contains one span per shot. Multiple spans become
possible only through later human-approved cutting or merging.

### Assets and selections

- `Asset`
- `AssetFile`
- `ShotCandidate`
- `AssetProvenance`
- `ShotSelection`
- `FormatOverride`

Assets are reusable across shots. Detaching a candidate never deletes its bytes
while history or another project record references it.

### Agent collaboration

- `AgentSession`
- `AgentClaim`
- `AgentTask`
- `TaskReceipt`
- `EditorialProposal`
- `ProposalOperation`

A task and proposal store the base project revision. Task receipts remain
compact and do not mirror complete external chat.

### History and jobs

- `ChangeEvent`
- `Checkpoint`
- `Job`
- `JobAttempt`
- `RenderArtifact`

Each protected mutation is attributed and reversible. Named checkpoints point
to a durable project revision. Version one exposes linear history, not
branching edit graphs.

## Authority Rules

The local service enforces the following matrix:

| Operation | Human browser | Agent CLI |
| --- | --- | --- |
| Read project context | Yes | Yes, scoped |
| Attach candidate asset | Yes | Yes |
| Add provenance or task note | Yes | Yes |
| Recommend a candidate | N/A | Yes |
| Select active visual | Yes | Proposal only |
| Correct transcript | Yes | Proposal only |
| Change shot boundary/order | Yes | Proposal only |
| Change output settings | Yes | Proposal only |
| Accept editorial proposal | Yes | No |
| Export with incomplete shots | Explicit confirmation | No |

Service-side authorization is authoritative. Hiding a browser button is never
treated as a security or integrity boundary.

## Local Safety and Privacy

- The service binds to loopback by default.
- CLI sessions use revocable local credentials and scoped claims.
- Provider secrets are supplied through local secure configuration and are not
  written into project history.
- Managed-media paths are resolved under an explicit project media root.
- Intake rejects path traversal, unsupported files, and symlink escapes.
- The service never executes a path or shell command supplied by a project.
- External provider calls occur only after the user configures and invokes the
  corresponding adapter.

## Failure Handling

Long-running work is persistent and uses these states:

- queued
- claimed
- running
- waiting for input
- succeeded
- failed
- canceled

Closing the browser does not lose a job. If an agent disconnects, its claim
expires and its task becomes reclaimable. Additive assets already attached stay
attributed, while the task receipt is marked interrupted.

Transcription preserves the source audio and raw provider response. Retry creates
a new attempt; it never overwrites a usable transcript.

Invalid, stale, or unauthorized agent proposals fail closed and leave the
current edit untouched. The service returns structured diagnostics naming the
invalid operations.

Preview and export run deterministic preflight checks. Missing visuals are
warnings with placeholder behavior. Missing audio, unreadable media, invalid
source ranges, and impossible output dimensions are blocking errors.

Render jobs write to temporary locations and atomically publish only successful
artifacts. A failed or canceled attempt never replaces the last valid output.

Browser mutations commit transactionally and return confirmed revision IDs.
Undo and checkpoint restore are service operations, not local-only UI state.

## Testing Strategy

### Shared-model tests

Cover transcript normalization, corrections, shot spans, split/merge ancestry,
cuts, reordering, proposal staleness, format overrides, and authority rules.

### Service integration tests

Cover SQLite transactions, revision conflicts, checkpoints, claims, job retries,
managed-file safety, checksums, candidate attachment, human selection, event
delivery, and atomic render publication.

### CLI contract tests

Prove that an agent can read the same state visible to the browser, claim a
targeted task, attach a candidate, complete a receipt, and submit—but not apply—
a protected editorial change.

### Browser workflow tests

Cover audio upload, transcription/import, transcript correction, shot proposal
and approval, asset attachment and selection, history, preview, and export.

### Deterministic media fixtures

Short fixture projects verify output duration, reordered audio, static images,
video trimming and final-frame freezing, muted candidate audio, captions, crop
overrides, missing-visual placeholders, and both aspect ratios.

### Performance fixture

A 15-minute, 150-shot project verifies responsive windowed scrolling and proves
that incoming agent and job events do not reset position or lose draft input.

## Interactive Prototype Evidence

The deterministic prototype is the interaction oracle for implementation
planning. It is not the production architecture or domain model.

Run it with `npm run dev` and open `http://rant-studio.localhost:4173/`.

| Evidence | Reference | What it establishes |
| --- | --- | --- |
| Stateful workflow | [`src/App.tsx`](../../../src/App.tsx) | Raw transcript, staged proposal, accepted ledger, human/agent collaboration, preview, and export authority states |
| Responsive layout | [`src/styles.css`](../../../src/styles.css) | Desktop ledger, reachable mobile navigation, bounded transcript cells, command dock, and modal presentation |
| Editorial oracle | [`tests/editorial-core.spec.ts`](../../../tests/editorial-core.spec.ts) | Transcript preservation, staged acceptance, boundary review, rejection, and regeneration |
| Collaboration oracle | [`tests/collaboration-output.spec.ts`](../../../tests/collaboration-output.spec.ts) | Human selection authority, agent task receipts, upload provenance, preview formats, export, and reset |
| UX hardening oracle | [`tests/ux-hardening.spec.ts`](../../../tests/ux-hardening.spec.ts) | Long transcript containment, accepted-state fidelity, responsive navigation, focus management, cancellable fake work, dynamic preflight, and row-to-dock targeting |

The prototype deliberately disables controls whose production behavior is not
simulated. An enabled control must perform an observable transition; a disabled
control is a visible planning marker, not evidence that its workflow is
complete.

### Prototype invariants to preserve

- Corrected transcript text survives proposal review and acceptance.
- A shared boundary update keeps adjacent shot endpoints contiguous.
- Accepted pacing and timing appear unchanged in the Shot Ledger.
- Long transcript chunks wrap and scroll inside bounded proposal and ledger
  cells without introducing horizontal page overflow.
- Project views and primary project actions remain reachable at narrow widths.
- The mobile agent dock starts compact without hiding its target or status and
  expands into the shared command surface on demand.
- Candidate totals match the reachable asset controls in a bounded,
  horizontally scrollable tray.
- Dialogs are named, modal, Escape-closeable, focus-contained, and restore focus
  to their opener.
- Reset cancels in-flight work so stale callbacks cannot repopulate cleared
  state.
- Export headings, incomplete-shot lists, and authority confirmation copy derive
  from one live source of truth.
- Row-level agent actions explicitly target a shot and populate the shared agent
  command surface.
- Accepted proposal work and later agent work produce visible receipts.

### Production gaps the implementation plan must carry

The following are intentionally not satisfied by the five-shot prototype and
must become explicit GoalBuddy tasks with their own acceptance criteria:

1. Project creation, narration upload, transcription/import, validation, retry,
   and provider configuration.
2. Durable revisions, word-linked transcript corrections, stable shot IDs,
   split/merge ancestry, protected proposals, checkpoints, and undo/restore.
3. A 150-shot stress fixture with windowed ledger rendering, search, filtering,
   completion summary, jump controls, and scroll/draft preservation during live
   events.
4. Long-transcript navigation with find/jump, chunked correction, and
   word-timestamp integrity.
5. Candidate trays that expose every candidate through bounded scrolling or
   pagination while preserving selection, provenance, and position.
6. Single- and multi-shot agent targeting, session selection, cancellable jobs,
   stale-result guards, waiting/error/retry states, and durable receipts.
7. Append-only, filterable Activity and History collections rather than the
   prototype's compact in-memory examples.
8. Preview state per shot and per output format, independent caption controls,
   missing-visual placeholders, return-to-shot navigation, and real media
   semantics.
9. Revision-bound export preflight, dynamic warnings and blockers, placeholder
   authorization, persistent render jobs, and atomic artifact publication.
10. Browser and CLI contract tests proving both surfaces observe the same
    revisions and that agents cannot apply protected human decisions.

### GoalBuddy implementation-plan seed

The next GoalBuddy Prep run should use this specification as the product
contract and the prototype evidence table as its interaction oracle. Every
implementation task should name:

- the production boundary it owns;
- the prototype state or test that demonstrates the intended interaction;
- the production-only gaps it closes;
- observable acceptance criteria, including error and stale-state behavior;
- verification commands or fixtures; and
- dependencies on prior schema, service, CLI, media, or browser work.

The implementation board should not treat the completed mock-up board as an
execution dependency. It should link to it as design evidence and create fresh
tasks for the production system.

## Version-One Acceptance Criteria

Version one is complete when a creator can:

1. Upload one narration track.
2. Produce or import a word-timestamp transcript.
3. Correct transcription mistakes.
4. Explicitly obtain and approve a chronological shot proposal from an attached
   external agent.
5. Cut or reorder accepted narration.
6. Upload visual candidates and receive agent-attached candidates.
7. Retain human control over active selections.
8. Preview individual shots and the assembled edit.
9. Render valid 16:9 and 9:16 MP4 files.
10. Review attributed task receipts and undo or restore editorial changes.

The workflow must not require editing JSON, touching SQLite, manually arranging
managed media, or granting an agent hidden editorial authority.

## Explicit Non-Goals

- Built-in audio recording
- Built-in web asset search
- Built-in image or video generation providers
- Layered compositions or overlays
- Automatic image motion
- Agent-authored motion treatments
- Multiple simultaneous human editors
- Hosted storage, authentication, or remote collaboration
- Branching edit histories
- Arbitrary resolutions or aspect ratios
- Hour-long project optimization
- Automated YouTube publishing

These are possible later extensions, not architectural prerequisites for the
first release.
