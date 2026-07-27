# Rant Studio Interactive HTML Mock-up

## Objective

Build and verify a cohesive interactive browser prototype of the approved Rant
Studio version-one UX without beginning the production backend, media pipeline,
or agent runtime.

## Original Request

Plan and build an interactive HTML mock-up for the approved Rant Studio UX,
using GoalBuddy Prep and rigorous acceptance criteria where they improve the
chance of a coherent result.

## Intake Summary

- Input shape: `existing_plan`
- Audience: The product owner evaluating Rant Studio's first UX
- Authority: `approved`
- Proof type: `demo`
- Completion proof: A locally served interactive prototype passes its automated
  checks and a final browser walkthrough of the approved end-to-end mock flow.
- Goal oracle: A repeatable browser walkthrough proves that the raw transcript,
  staged shot proposal, accepted Shot Ledger, asset candidates, agent task
  receipt, format preview, and export preflight behave as one coherent product.
- Likely misfire: Producing attractive disconnected screens or starting the
  production architecture instead of validating one interactive UX.
- Blind spots considered: Over-decomposed tasks, stale mock state, weak
  transitions between screens, inaccessible controls, and fake interactions
  that do not preserve believable project state.
- Existing plan facts: The approved product and system design is
  `docs/superpowers/specs/2026-07-27-rant-studio-design.md`; the selected UX is a
  full-width Shot Ledger, selection-aware agent dock, and on-demand preview.

## Goal Oracle

The oracle for this goal is:

`From a clean local start, the prototype passes its automated build and browser
checks, then a final in-app browser walkthrough demonstrates every required
state transition without console errors or contradictions with the approved
design spec.`

The PM must keep comparing task receipts to this oracle. Planning, discovery, a
passing tiny slice, or a clean-looking board is not enough. The goal finishes
only when a final Judge/PM audit maps receipts and verification back to this
oracle and records `full_outcome_complete: true`.

## Goal Kind

`existing_plan`

## Current Tranche

Continuously advance through the largest safe UX slices until the complete
interactive mock-up and its proof walkthrough satisfy the oracle. The tranche
ends at a validated prototype, not production application infrastructure.

## Non-Negotiable Constraints

- Treat the approved design spec as product truth.
- Build a prototype with deterministic seeded data, not a production backend.
- Do not implement real transcription, media rendering, provider calls, SQLite,
  agent claims, or CLI integration.
- Simulated interactions must preserve believable shared project state across
  the walkthrough.
- Prefer a small TypeScript browser app over a pile of disconnected HTML files.
- Keep the visual hierarchy centered on the Shot Ledger.
- Human authority over active asset selection must remain visible.
- The mock-up must be keyboard-usable and avoid color-only status indicators.
- Do not publish or deploy the prototype unless the owner separately requests
  it.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, or Judge selection if a safe Worker task
can be activated.

Do not stop after one verified slice while required walkthrough states remain.
Advance to the next largest safe slice unless a phase, risk,
rejected-verification, ambiguity, or final-completion review is due.

Do not create one Worker/Judge pair per component. Implement and review complete
behavioral slices.

## Slice Sizing

Safe means bounded, explicit, verified, and reversible. It does not mean tiny.

For this goal, a good Worker slice changes the walkthrough materially: first the
editorial transition from transcript to Shot Ledger, then the collaboration and
output path that completes the prototype.

## Board Health

The PM owns board health. If the board looks stale or inconsistent, run:

```bash
node /Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.4.1/skills/goal-prep/scripts/check-goal-state.mjs docs/goals/rant-studio-interactive-mockup
```

## Canonical Board

Machine truth lives at:

`docs/goals/rant-studio-interactive-mockup/state.yaml`

## Run Command

```text
/goal Follow docs/goals/rant-studio-interactive-mockup/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter and the GoalBuddy execution contract.
2. Read `state.yaml`.
3. Work only on the active board task.
4. Record a compact receipt and update the board.
5. Continue into the next safe required slice unless a review boundary is due.
6. Finish only when the final audit maps verified behavior to the full oracle.
