# Semantic Shot Planning

## Objective

Build and verify a complete external-agent semantic shot-planning workflow for
Rant Studio. A creator must be able to ask an attached CLI agent either to
discover useful chronological shots from a corrected transcript or to map that
transcript onto a creator-supplied outline, then review the staged proposal in
the browser before accepting it.

## Original Request

Plan the next implementation tranche for semantic shot organization, supporting
both agent-discovered structure and human-directed shot outlines.

## Intake Summary

- Input shape: `specific`
- Audience: local commentary-video creators and the CLI agents working beside
  them
- Authority: `requested`
- Proof type: `demo`
- Completion proof: the current 10m17s, 1,463-word QA transcript and two small
  deterministic fixtures pass structural verification, and a human walkthrough
  demonstrates useful semantic boundaries and themes in both planning modes
- Goal oracle: an attached agent can claim a revision-bound planning task,
  inspect all required transcript and direction context, submit a complete
  semantic proposal, and hand it back to the browser for human review without
  losing, duplicating, reordering, or automatically cutting transcript words
- Likely misfire: relabeling equal chronological thirds with plausible-sounding
  themes while leaving boundaries non-semantic
- Blind spots considered: external-agent versus built-in-provider ownership;
  semantic quality versus structural coverage; soft target versus exact shot
  count; directed-mode input shape; long transcript chunks; stale revisions;
  raw transcript immutability; staged human approval; secret leakage; and
  persistence across restart
- Existing plan facts: the current QA baseline creates three generic equal
  chunks; default starting count is three; count is a soft target with optional
  advanced bounds; directed mode accepts free-form direction plus optional
  ordered shot briefs; transcript coverage must be exact and chronological; and
  narration cuts remain a later explicit human ledger action

## Goal Oracle

The oracle for this goal is:

`On the existing 10m17s / 1,463-word Groq transcript, an attached CLI agent
completes both discover-structure and map-to-outline tasks, the browser shows
specific themes, rationales, transcript spans, and any explained shot-count
deviation for human review, structural checks prove every corrected word occurs
exactly once in original order with no gaps or overlap, the raw provider
transcript is unchanged, and accepted results survive a service restart. Two
small deterministic fixtures exercise the same contracts in automated tests.`

The PM must keep comparing task receipts to this oracle. Planning, discovery, a
passing tiny slice, or a clean-looking board is not enough. The goal finishes
only when a final Judge/PM audit maps receipts and verification back to this
oracle and records `full_outcome_complete: true`.

## Goal Kind

`specific`

## Current Tranche

Complete the whole locally verifiable semantic-planning outcome: map the current
task/proposal contracts, choose the largest safe compatible design, implement
both modes through the browser and CLI work surfaces, preserve revision and
human-approval guarantees, add deterministic structural coverage, and perform
the real-media walkthrough. Do not stop after producing an architecture or a
data model when a safe end-to-end slice remains.

## Acceptance Criteria

1. The browser can queue either `discover structure` or `map to outline` against
   the current corrected-transcript revision.
2. Discover mode begins with a soft target of three shots. The agent may deviate
   within configured advanced constraints and must explain the deviation.
3. Directed mode accepts free-form direction and optional ordered shot briefs,
   and those inputs are available identically to the attached CLI agent.
4. A claimed task gives the agent enough revision-bound context to inspect the
   full corrected transcript, timestamps, planning mode, target, constraints,
   and creator direction without copying secrets into task payloads or receipts.
5. An agent can submit arbitrary chronological semantic shots with stable
   identities, specific themes, rationales, transcript spans, and optional
   asset ideas. Generic `Beat 1/2/3` output does not satisfy the semantic proof.
6. Every corrected transcript word belongs to exactly one proposed shot in
   original order. Proposals with gaps, overlaps, duplicates, reordering, or
   out-of-range boundaries are rejected deterministically.
7. The raw provider transcript remains immutable, and creating or accepting a
   shot plan does not create narration cuts.
8. Proposals are staged for human review. The creator can inspect long
   scrollable transcript chunks, accept or reject the proposal, and receive a
   clear stale-revision failure rather than silently applying obsolete work.
9. Accepted shot plans and task state survive the existing persistence and
   restart path, with replay/idempotency behavior preserved.
10. Model, service, CLI, browser, and oracle tests cover the shared contract and
    two deterministic fixtures. The current real transcript completes a manual
    Chrome/CLI walkthrough in both modes and receives human semantic-quality
    review.

## Non-Negotiable Constraints

- Semantic reasoning belongs to an attached external CLI agent in this tranche;
  do not add a built-in LLM or transcription-provider planning dependency.
- Preserve the mirrored human/agent work surface: browser decisions and CLI
  task state must share one canonical project/revision contract.
- Preserve every corrected transcript word exactly once, chronologically.
- Never mutate the raw provider transcript.
- Never convert a planning proposal into narration cuts automatically.
- Keep proposals staged until explicit human acceptance.
- Preserve project revision, idempotency, persistence, and stale-task
  protections.
- Treat three shots as a default soft target, not a mandatory equal partition.
- Keep free-form direction and ordered briefs optional and available to both
  browser and CLI participants.
- Do not place API keys, credentials, or other secrets in planning prompts,
  task payloads, logs, or receipts.
- Preserve unrelated user changes in the current dirty worktree.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, or Judge selection if the user asked for
working software or automation and a safe Worker task can be activated.

Do not stop after a single verified Worker package when the broader owner
outcome still has safe local follow-up work. Advance the board to the next
highest-leverage safe Worker package and continue unless a phase, risk,
rejected-verification, ambiguity, or final-completion review is due.

Do not create one Worker/Judge pair per repeated file, table, route, or helper.
Put repeated same-shape work into one Worker package and review the package as a
whole.

Do not stop because a slice needs owner input, credentials, production access,
destructive operations, or policy decisions. Mark that exact slice blocked with
a receipt, create the smallest safe follow-up or workaround task, and continue
all local, non-destructive work that can still move the goal toward the full
outcome.

If an exact human approval phrase is the only remaining blocker and no safe
local work remains, ask once and stop. Preserve the exact phrase in the blocked
receipt as `required_reply`, set `waiting_for_user_approval: true`, set
`goal.status: blocked`, and set `active_task: null`. Do not keep posting approval
prompts until the user replies.

## Slice Sizing

Safe means bounded, explicit, verified, and reversible. It does not mean tiny.

A good task is the largest safe useful slice.

Small is not the goal. Useful is the goal.

A Worker should finish the whole assigned slice. A Judge should judge the whole
assigned slice. A PM should reorient the board when tasks are safe but not
moving the outcome.

Tiny tasks are allowed when the failure is isolated, the risk is high, the
scope is unknown, or the tiny task unlocks a larger slice. Tiny tasks are bad
when they keep happening, do not change behavior, only add
wrappers/contracts/proof files, or avoid the real milestone.

## Board Health

The PM owns board health. If the board looks stale, misleading, offline, or
inconsistent, run:

```bash
node /Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.4.1/skills/goal-prep/scripts/check-goal-state.mjs docs/goals/semantic-shot-planning
```

If the local board is running, compare `state.yaml` to the live board API.
Repair only GoalBuddy control files unless an active Worker or PM task
explicitly allows product-file edits.

## Canonical Board

Machine truth lives at:

`docs/goals/semantic-shot-planning/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status,
active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/semantic-shot-planning/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter and follow GoalBuddy's execution contract.
2. Read `state.yaml`.
3. Run the bundled GoalBuddy update checker when available and mention a newer
   version without blocking.
4. Re-check the intake, oracle, blind spots, existing plan facts, and likely
   misfire.
5. Work only on the active board task.
6. Assign Scout, Judge, Worker, or PM according to the task.
7. Write a compact task receipt.
8. Update the board.
9. If safe local work remains, choose the next largest reversible Worker
   package and continue unless a phase, risk, rejected-verification, ambiguity,
   or final-completion review is due.
10. Review at phase, risk, rejected-verification, ambiguity, or final-completion
    boundaries; do not review every small Worker by habit.
11. Finish only with a Judge/PM audit receipt that maps receipts and
    verification back to the original outcome and records
    `full_outcome_complete: true`.
