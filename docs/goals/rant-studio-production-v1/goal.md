# Rant Studio Production V1

## Objective

Build the approved local-first Rant Studio V1 as working production software:
a shared browser and agent-CLI work surface that turns one narration track into
an editable, visually supported commentary video and renders valid 16:9 and
9:16 MP4 outputs.

## Original Request

Use the approved Rant Studio specification and fixed interactive mock-up to
prepare and then execute a rigorous production implementation plan with
GoalBuddy.

## Intake Summary

- Input shape: `existing_plan`
- Audience: Individual YouTube commentary creators collaborating with external
  coding agents
- Authority: `approved`
- Proof type: `test`
- Completion proof: A fresh local fixture completes the entire browser-and-CLI
  workflow, renders both required MP4 formats, passes the deterministic media
  and 150-shot performance fixtures, and a final Judge maps the evidence back to
  every V1 acceptance criterion.
- Goal oracle: The production workflow and gate suites described below
- Likely misfire: Rebuilding the attractive five-shot mock-up without the
  durable domain model, shared CLI/browser state, authority enforcement, real
  media semantics, failure recovery, or 150-shot behavior required for V1
- Blind spots considered: Provider boundaries, media safety, revision
  conflicts, stale agent results, cancellation, windowing, scroll/draft
  preservation, per-shot/per-format overrides, deterministic export, and
  migration from prototype state to production state
- Existing plan facts:
  - `docs/superpowers/specs/2026-07-27-rant-studio-design.md` is the approved
    product and architecture contract.
  - The “Interactive Prototype Evidence” section links the implementation
    oracle and enumerates production gaps.
  - `src/App.tsx`, `src/styles.css`, and the browser tests demonstrate the
    approved interaction, but are not the production data model.
  - The completed `rant-studio-interactive-mockup` board is design evidence,
    not an execution dependency.
  - The product is local-first, TypeScript-based, SQLite-backed, loopback-only
    by default, and exposes the same revisioned project state to the browser and
    agent CLI.
  - Human approval is required for protected editorial changes, active visual
    selection, output-setting changes, and incomplete export.

## Goal Oracle

The oracle for this goal is:

`On a fresh local project, upload narration or import the deterministic audio
fixture; produce or import a word-timestamp transcript; correct it; have an
attached CLI agent submit a chronological shot proposal; review and accept it
in the browser; cut or reorder narration; attach human and agent candidates;
retain human-only active selection; preview shots and the assembly; inspect
receipts and restore history; render valid 16:9 and 9:16 MP4s; then pass shared
model, service, CLI contract, browser workflow, deterministic media, safety,
and 150-shot performance gates.`

The PM must keep comparing task receipts to this oracle. Planning, discovery, a
passing tiny slice, or a clean-looking board is not enough. The goal finishes
only when a final Judge/PM audit maps receipts and verification back to this
oracle and records `full_outcome_complete: true`.

## Goal Kind

`existing_plan`

## Current Tranche

Continuous production implementation. Validate the approved plan against repo
reality, then complete successive coherent vertical slices until the full V1
oracle is true. The first execution task is a read-only Judge review that may
repair task boundaries, file scopes, dependencies, and verification without
weakening the approved outcome.

## Non-Negotiable Constraints

- Preserve the interaction invariants in the prototype evidence section.
- Treat the approved design specification as the product contract.
- Do not derive production persistence from the mock-up’s in-memory arrays.
- Browser and CLI must observe the same revisioned local project state.
- Agents may add candidates, provenance, notes, receipts, and proposals, but
  may not apply protected human decisions.
- Managed media must remain under an explicit project root and reject traversal,
  unsupported files, and symlink escapes.
- Provider secrets must not enter project history.
- Preview and export must have deterministic warning and blocking behavior.
- Preserve unrelated user work and do not rewrite the approved specification
  merely to make implementation easier.
- Use test-first implementation for every behavior change.
- Keep exactly one active board task unless the PM proves disjoint write scopes.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, or Judge selection while safe
implementation work remains. Do not stop after a single vertical slice if the
broader V1 oracle is still false.

If an exact owner decision, credential, production access, or destructive action
blocks one slice, record that block precisely and continue all safe local work.
Ask once only when that approval is the final remaining blocker.

## Slice Sizing

Safe means bounded, explicit, verified, and reversible. It does not mean tiny.
Each Worker owns one coherent vertical slice, including its domain, service,
browser/CLI boundary where applicable, tests, and migration/documentation
needed to make that slice operable.

The Judge should merge or split queued tasks when repo evidence shows a safer
or more useful boundary, but must preserve all acceptance criteria.

## Board Health

Machine truth lives in
`docs/goals/rant-studio-production-v1/state.yaml`.

If the board looks stale or inconsistent, run:

```bash
node /Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.4.1/skills/goal-prep/scripts/check-goal-state.mjs docs/goals/rant-studio-production-v1
```

## Run Command

```text
/goal Follow docs/goals/rant-studio-production-v1/goal.md.
```

## PM Loop

1. Read this charter, the GoalBuddy execution contract, and `state.yaml`.
2. Work only on the active task.
3. Use the installed Scout, Judge, or Worker role named by the task.
4. Preserve and validate the approved plan before writing production code.
5. Require a compact receipt and current verification for every completed task.
6. Review at architecture, risk, media, integration, and final boundaries.
7. Continue to the next largest safe slice until the full oracle is true.
8. Finish only through T999 with `full_outcome_complete: true`.
