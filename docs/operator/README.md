# Rant Studio operator guide

## Service lifecycle

Start with `npm run service`. The process opens the versioned SQLite store,
applies only additive migrations, reclassifies interrupted render jobs as
`waiting`, and listens only on `127.0.0.1`. Stop with Ctrl-C so HTTP and SQLite
close cleanly.

Real transcription is opt-in and server-side:

```bash
cp .env.example .env.local
# Edit .env.local, which is ignored by Git, then:
npm run service

# Or configure the current shell:
RANT_STUDIO_TRANSCRIPTION_PROVIDER=openai \
OPENAI_API_KEY='<server-only key>' \
RANT_STUDIO_TRANSCRIPTION_LANGUAGE=en \
npm run service
```

Use `RANT_STUDIO_TRANSCRIPTION_PROVIDER=groq` with `GROQ_API_KEY` for Groq
Cloud Whisper. Omit `RANT_STUDIO_TRANSCRIPTION_LANGUAGE` for automatic
language detection. Without a configured remote provider, the service uses
its deterministic offline fixture.

For persistent QA, start the service once and use its loopback URL in a second
terminal. Local owner commands do not require a startup token:

```bash
export RANT_STUDIO_URL=http://127.0.0.1:4174
npm run rant -- provider configure openai
npm run rant -- provider test openai
npm run rant -- provider list --json
```

`provider configure` uses a hidden prompt. For non-interactive local
automation, add `--stdin` and pipe the key through standard input; do not place
it in the command itself. The key is stored in macOS Keychain. SQLite keeps
provider status and selection metadata only. Use `provider configure` again to
rotate, `provider select` to change the active persisted provider, and
`provider remove` to delete its Keychain item. An external agent must set the
printed `RANT_STUDIO_CREDENTIAL`; agent credentials may run `provider list`,
but provider changes remain unavailable to them.

Treat the printed agent credential as a local secret. The local owner app is
authorized only from the exact Rant Studio origin, and owner CLI calls are
accepted only by the loopback-bound service without a browser origin. Agent
credentials are intentionally restricted and remain separate from
transcription-provider keys.

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
