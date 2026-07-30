# Persistent Transcription Credentials

## Objective

Implement a secure, persistent, shared human-agent provider configuration surface for OpenAI and Groq transcription credentials while retaining environment-variable overrides for CI and temporary QA.

## Original Request

Create an implementation plan using GoalBuddy Prep for persistent API keys that humans can configure in the app and agents can configure or use from the CLI.

## Intake Summary

- Input shape: `existing_plan`
- Audience: Rant Studio users and their collaborating agents
- Authority: `requested`
- Proof type: `test`
- Completion proof: A browser-and-CLI walkthrough configures, validates, uses, rotates, and removes provider credentials without exposing raw secrets, and the full release suite passes.
- Goal oracle: A credential leakage test plus an end-to-end transcription walkthrough using a persisted Keychain credential.
- Likely misfire: Delivering a settings form or encrypted database field that appears persistent but leaks secrets to the browser, SQLite, logs, receipts, command arguments, or project files.
- Blind spots considered: macOS Keychain behavior in automated tests, exact-origin protection, credential precedence, agent authority, rotation/removal semantics, legacy environment compatibility, and preserving the current dirty transcription work.
- Existing plan facts: Use macOS Keychain for raw secrets; store metadata only in SQLite; provide app and CLI configuration; never reveal saved keys; keep environment overrides; expose provider readiness to agents; support OpenAI and Groq; verify absence of secrets across persistence and observability surfaces. The owner corrected an earlier ambiguity: the intended second provider is Groq Cloud, not xAI Grok.

## Goal Oracle

The oracle for this goal is:

`Automated secret-canary tests prove the raw credential never appears in browser responses, local/session storage, SQLite, logs, activity receipts, project files, snapshots, or CLI arguments; then a browser-and-CLI QA walkthrough persists a Keychain credential across service restart, transcribes the selected QA media, rotates and removes the credential, and npm run test:release passes.`

The PM must keep comparing task receipts to this oracle. Planning, discovery, a passing tiny slice, or a clean-looking board is not enough. The goal finishes only when a final Judge/PM audit maps receipts and verification back to this oracle and records `full_outcome_complete: true`.

## Goal Kind

`existing_plan`

## Current Tranche

Validate the agreed architecture against the current dirty branch, then implement and verify the complete local macOS credential workflow as successive safe vertical slices: contract and threat model, Keychain-backed service and metadata, tokenless local-owner app and CLI access, restricted agent access, app settings, transcription integration, and full security/release proof.

## Non-Negotiable Constraints

- Raw provider credentials must live in macOS Keychain, never SQLite or the project directory.
- The browser and collaborating agent may observe provider capability and health but may never retrieve a saved credential.
- Environment variables remain the highest-precedence, non-persistent override for CI, automation, and temporary QA.
- The selected Keychain credential is the persistent fallback; deterministic transcription remains available when no remote credential is selected.
- Secret-management requests must be restricted to the exact approved app origin, not every localhost subdomain.
- The local human app must connect automatically without asking the owner to copy a startup token; exact-origin browser requests and originless loopback owner CLI requests form the local-owner boundary.
- External agent access remains separately credentialed and least-privileged.
- Credentials must never appear in browser storage, API responses, SQLite, logs, receipts, transcripts, snapshots, test artifacts, shell history, process arguments, or committed files.
- CLI credential input must use a secure TTY prompt or stdin and must not accept raw secret values as ordinary command arguments.
- Rotation and removal must invalidate any runtime cache immediately.
- Existing uncommitted work on `codex/mp3-mp4-narration` belongs to the user/current effort and must not be reverted or overwritten.
- Support OpenAI and Groq first; cross-platform credential stores, multiple named profiles, and multi-user/cloud secret sync are non-goals for this tranche.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, or Judge selection if a safe Worker task can be activated.

Do not stop after a single verified Worker package when the broader owner outcome still has safe local follow-up work.

If live provider QA is blocked only by the absence of a user-owned credential, complete all deterministic, fake-Keychain, canary, UI, CLI, and release verification first; then record the exact remaining walkthrough and request the credential through the implemented secure surface rather than chat.

## Slice Sizing

Safe means bounded, explicit, verified, and reversible. It does not mean tiny. Prefer complete vertical slices whose contract, implementation, tests, and user-visible behavior land together.

## Board Health

The PM owns board health. If the board looks stale, misleading, offline, or inconsistent, run:

```bash
node /Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.4.1/skills/goal-prep/scripts/check-goal-state.mjs docs/goals/persistent-transcription-credentials
```

## Canonical Board

Machine truth lives at:

`docs/goals/persistent-transcription-credentials/state.yaml`

## Run Command

```text
/goal Follow docs/goals/persistent-transcription-credentials/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter and the GoalBuddy execution contract.
2. Read `state.yaml`.
3. Work only on the active task.
4. Preserve the dirty transcription-provider work and use receipts to record findings.
5. Run the oracle after each Worker package where applicable.
6. Continue through safe local work until the final audit proves the whole outcome.
