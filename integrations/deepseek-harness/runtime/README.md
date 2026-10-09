# GamePilot DSH runtime

This is an isolated runtime project, separate from GamePilot's root dependencies.
It uses official `@deepseek-ai/dsh` and `@deepseek-ai/dsh-sdk-client` version
`0.2.1-alpha.1`. The reviewed source is commit
`5badb15009ae1756c3afe0ae0cef1faafc290ccc`; npm payloads and transitive versions are
fixed by this directory's lockfile and its integrity entries.

`launcher.mjs` imports the official `HarnessClient`, which launches the official
CLI with `--profile sdk-minimal --patch gamepilot.cordis.patch.yml`. The overlay
disables the default shell, terminal, sandbox, subprocess, jobs, retry adapter,
DeepSeek endpoint adapter, and basic SDK server. It inserts a trusted Cordis
plugin. That plugin imports the official `HarnessSdkJsonRpcServer` and
`JsonRpcLineTransport`, registers the model adapter and host tools with the real
DSH registries, and uses official agent creation, resume, cancellation and JSONL
persistence. No third-party source files are modified. No second desktop app
starts. GamePilot spawns the SDK launcher with `windowsHide: true`; its DSH Node
child inherits the hidden console.

The fixed SDK has only initialize, prompt and shutdown. The trusted plugin adds
`gamepilot/session/open`, `gamepilot/session/history` and
`gamepilot/session/cancel`. These are host control methods, never model tools.
The host also exposes `follow` through the SDK's real session-event subscription
plus an initial durable history snapshot. It buffers during the snapshot and
de-duplicates by event sequence, so history and live delivery share one cursor.
Resume uses `agents.resume`; only the official `SessionPersistenceNotFoundError`
permits creating a first conversation session. Ownership, corruption and format
failures refuse activation without replacing the persisted session. It clears
persisted pending inbox messages before
publication so historical input cannot replay host operations. DSH's original
interrupted-turn repair still records tool-not-started and unknown-outcome
facts. GamePilot must reconcile its execution ledger before supplying new
authorized input. Cancelling this runtime stops model activity only; stopping
accepted game work remains the host's independent responsibility.

The model adapter sends provider-neutral requests to an authenticated, ephemeral
`127.0.0.1` bridge. GamePilot's `withCompatibleHttp` performs actual
`/chat/completions` requests. Provider endpoint and key remain in the host; they
are absent from argv, child environment, metadata, model-facing requests, events
and JSONL. Only the supplied host tool allowlist registers with DSH. The host
checks the allowlist again on dispatch and passes cancellation to the tool.
Public events and history omit reasoning, system prompts, request headers and
raw provider diagnostics.
Each owned agent also uses the official scoped tool restriction, and a monotonic
registry guard denies names outside the supplied host allowlist. Extra native
tools inserted into a profile cannot become model execution authority.

From the workspace root, prepare the portable dependency directory:

```powershell
node scripts/setup-dsh-runtime.mjs
```

The default reviewed Node source is the installed DSH primary runtime. To use an
archived copy, supply `--node <node.exe>` and optionally
`--node-license <LICENSE>`. The script checks both SHA256 values and the actual
`v24.21.0` executable version against `node-runtime.json`. The installation's
`runtime/versions.json` says a different Node version, so it is not accepted as
version evidence. No Node or npm is installed system-wide. `--npm <npm-cli.js>`
selects an existing npm implementation if necessary. `--no-install` validates
already installed dependencies while preparing Node, licenses and provenance.
`--target <workspace/artifacts/name>` makes a separate copy. Targets outside the
workspace, workspace root dependencies, and runtime symlinks/junctions are
refused before npm can replace `node_modules`.

Copy the prepared directory to `resources/gamepilot-dsh-runtime` for a portable
release, including `node`, `node_modules`, `licenses`, `runtime-build-info.json`,
the lock, launcher, plugin and overlay. Exclude this README's local `artifacts`
and `.gitignore`. Node's license and all installed package license files are
collected in `licenses`; `THIRD_PARTY_NOTICES.json` records package version,
license, source, integrity and collected text. Keep original package licenses
in `node_modules` as well. Runtime state belongs in the host's configured user
data directory, separate from the shipped runtime. The default home is
`~/.gamepilot/dsh-runtime`; `DshRuntimeLocation.home` overrides it.

Offline verification uses the actual SDK/core against a local synthetic model
server, not a fake DSH process:

```powershell
node node_modules/vitest/vitest.mjs run tests/dsh-runtime.test.ts tests/dsh-protocol.test.ts tests/dsh-setup.test.ts
```

The proof covers the official tool loop, exact allowlist without shell, result
backflow, gap-free public follow, cold history, persistence/resume without
completed tool replay, model and cooperative tool cancellation, extra profile
tool refusal and a clean later turn. Unprepared environments explicitly skip
the actual-core suite; prepare the runtime to run this acceptance gate.
`GAMEPILOT_DSH_TEST_RUNTIME` can select a relocated runtime for the same offline
suite. It does not certify real provider behavior
or device actions. Real model/game acceptance remains a separate host check.
The bridge currently supports text only, limits one active turn per runtime,
caps a turn at 16 provider requests, and defaults to a 120-second model deadline.
It preserves provider streaming publicly while feeding completed neutral blocks
to DSH; unknown provider usage stays absent. Context compaction and images need
additional capability-aware adapters and are not enabled in this minimal tree.
