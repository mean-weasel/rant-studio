# T001 Judge Decision

## Oracle verdict

Approved. The oracle is strong enough because it requires both automated
browser proof and a final human-visible walkthrough across the complete
prototype. It explicitly rejects attractive disconnected screens and
production-infrastructure scope creep.

## First Worker acceptance matrix

| Area | Required observable behavior |
| --- | --- |
| App shell | A single locally served TypeScript app shows the approved Edit, Activity, History, Settings, preview, export, and attached-agent surfaces around one seeded project. |
| Raw default | The initial Edit state is an untouched timestamped transcript with no shots. A transcript correction can be made and is visibly distinguished without implying audio changed. |
| Shot controls | Propose shots exposes Relaxed, Standard, and Punchy presets plus collapsed advanced duration, word-count, and approximate-count settings. |
| Explicit agent action | No segmentation happens before the user invokes Propose shots. The action shows a deterministic attached-agent progress state. |
| Staged proposal | Proposed chronological boundaries, themes, timing, and reasons appear without replacing the raw transcript. The user can adjust a boundary, reject, or regenerate. |
| Atomic acceptance | Accepting the proposal creates the Shot Ledger in one state transition. Rejecting or regenerating does not partially apply shots. |
| Shot Ledger | The accepted state uses the approved full-width, vertically stacked, two-column narration/visual layout with missing-visual and candidate states. |
| Agent dock | Selecting a shot updates explicit target chips in the persistent bottom command dock. No command depends on ambiguous browser focus. |
| Proof | Static checks, production build, and an automated editorial-core browser scenario pass. The browser has no console errors on the verified path. |

## Largest safe Worker package

Build the complete editorial core from raw transcript through accepted Shot
Ledger. This is one coherent vertical slice: it changes the prototype from
unstarted to a believable editing workspace and provides the state foundation
needed by the later collaboration/output slice.

The queued T002 scope, allowed files, verification commands, and stop
conditions are appropriate without widening.
