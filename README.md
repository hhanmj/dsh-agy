# DSH × Antigravity (agy) Subagent

A DSH (DeepSeek Harness) plugin for delegating real coding tasks to the logged-in Google Antigravity CLI. Based on [ZEM17/dsh-subagent-agy](https://github.com/ZEM17/dsh-subagent-agy), MIT licensed.

**Version: 0.4.2.** New: a unified AGY activity model (tool steps shown live as started/finished/failed, folded into one collapsible panel when the turn ends), **experimental persistent CLI sessions** (`nativePersistentSessions`, off by default), and a per-turn token-usage fix (on resumed conversations AGY's `result.usage` is cumulative; DSH now gets the sum of this turn's model calls). Design notes and verification: [#2](https://github.com/hhanmj/dsh-agy/issues/2) and `docs/decisions/0001-v0.5.0-phase0.zh.md`.

The production-style one-shot task, follow-up and DSH Jobs workflows have been tested locally on DSH 0.2.0-rc.2. Native continuable child sessions are an **opt-in experimental feature**, tested with mocks, **not yet verified end-to-end in the DSH UI**.

## Features

- Foreground `antigravity` delegation through `ctx.subagents.start()`.
- Background AGY jobs, live output through DSH Jobs, cancel and independent working-tree evidence.
- `antigravity_followup` uses AGY's own conversation ID.
- `antigravity_models` lists what `agy models` really reports (models and effort variants; no agent turn, no quota). Native children accept optional `model` / `effort` (see below).
- `antigravity_trace` reads AGY's execution record (steps, AGY-internal tool calls, errors, result, cancellation/timeout, linked local evidence), paged by cursor. See below.
- **Experimental `antigravity_native_start`** uses real DSH `startContinuable()` to create a native DSH Agent and Session. A separate text-only model adapter delegates execution to AGY CLI and stores conversation ID mappings locally. The source default is off, but the v0.4.1 bundle patch explicitly enables the preview. Existing installations can toggle it using `scripts/set-native-preview.ps1`; not a GUI toggle.

## Install

Requires DSH 0.2.0-rc.2-compatible runtime, Node.js and the `agy` binary installed and logged in.

```powershell
npm ci
npm test
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stage-local-install.ps1
dsh plugin --profile web add ".\deploy\dsh-subagent-agy-reviewed"
```

**For DSH Desktop/Tauri install from the persistent directory, not a local `.tgz` file.** We observed its startup recovery report `INTERNAL_PLUGIN_DANGLING_LINK_UNINSTALLING` and remove a plugin registered via `file:...tgz`, along with its Profile config. The staged directory contains only packaged source output, is gitignored, and remains in place for the next start. Install using the profile actually started by your host, and restart the backend. This directory workaround still needs a restart test on the target Desktop. Avoid concurrent plugin-manager writes.

### v0.4.1 hotfix for scoped child-tool advertisements

DSH `toolFilter: { allow: [] }` masks global tools but may leave child-local tool registrations visible. This bridge now strips tool schemas and tool history before the AGY CLI invocation, while rejecting actual tool-role messages and non-text content. It never pretends to invoke host DSH tools.

To stage a fixed build without overwriting a live Junction target (still version 0.4.1):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "F:\agy-subagebt\scripts\stage-local-install.ps1" -StageName dsh-subagent-agy-reviewed-hotfix
dsh plugin --profile web add "F:\agy-subagebt\deploy\dsh-subagent-agy-reviewed-hotfix"
```

Wait for any active jobs, restart the DSH backend, and test with a fresh native child, not the failed child session.

## Experimental native child sessions

The staged v0.4.1 bundle configuration includes `nativeContinuableEnabled: true`; **no separate toggle is necessary for the directory installation**. For an already installed and intact plugin whose configuration lacks that setting, enable it with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "F:\\agy-subagebt\\scripts\\set-native-preview.ps1" -Enable
```

Use `-Disable` to turn it off. The script backs up your profile patch and defaults to `web` (override with `-Profile`). Restart the DSH backend and inspect `dsh --profile web --dump-config` for `nativeContinuableEnabled: true`. **This is a command-line toggle, not a graphical marketplace setting.** Then invoke `antigravity_native_start({description, prompt})` from a DSH Agent. The tool returns a durable DSH child Session ID after the initial prompt was accepted; it **does not wait for AGY to finish**. Inspect the native subagent tree and use the DSH `send_message` tool for follow-ups to that direct child.

This is **not** a fully capable DSH tools adapter: AGY CLI uses its own tools, while DSH-host tool declarations are intentionally blocked for the child. Native child-to-parent proactive messaging is not implemented. Text requests only. The first CLI call assembles the DSH text prompt, and subsequent calls use AGY `--conversation`. Native mappings are local state under `~/.dsh`, never repository content.

## Execution event bridge (stream-json)

Observed on AGY 1.4.0 `--output-format stream-json`: `init` (conversation_id, tool list, permission_mode), `step_update` (step_index, state ACTIVE/DONE/ERROR, step_type, text_delta, tool_name, `tool_info` = name / parameters / output / error, usage) and `result` (status, response, usage). `result.response` equals the joined text deltas (narration before tool calls included), so the bridge never appends the final answer twice. Sanitized real captures live in `scripts/fixtures/`. No `subagent_info` appeared in these captures; unknown fields are kept as opaque `extra` data rather than parsed from hearsay.

- **Native child sessions** receive AGY's visible text as live DSH `text-delta` chunks. AGY tool steps have no honest DSH StreamChunk equivalent, so they are never disguised as `tool-call-delta` or reasoning; they go to the trace. AGY's hidden reasoning is not in the stream and is never recorded.
- **Foreground / background / follow-up** runs use stream-json when supported, with unchanged result semantics. Background `job_output` markers now read `[agy: tool run_command done]` / `[agy: tool view_file error: ...]`, and multi-byte characters split across stdout chunks no longer turn into replacement characters.
- **Traces** are one file per native child id or task key under `~/.dsh/agy-traces` (never in the repository). Parameters, outputs and errors are redacted (tokens, passwords, private keys, URL credentials) and truncated; the workspace path becomes `.` and the home directory `~`; file-body parameters are reduced to their length. Per-trace caps and a 200-file rotation apply. Only the delegating parent agent can read a trace.
- **Four acceptance stages** in the trace summary: `started`, `execution` (running/completed/failed/cancelled/timeout/interrupted), `evidence` (local Git/file snapshot linked to `antigravity_evidence`) and `review` (always pending — the DSH parent must check code, build and tests itself).
- Settings: `traceEnabled` (default true), `traceDir`, `traceToolName`, `traceMaxEvents`, `traceMaxFiles`.

**Status:** implemented; offline tests pass (`npm test`); verified against real AGY 1.4.0 in throwaway directories (`node scripts/live-trace-e2e.mjs`); **verified inside DSH Desktop (2026-10-17)**: while a native child ran, `antigravity_trace` paged running → steps/tool call (`git rev-parse` output) → completed → local evidence, and a `send_message` follow-up was recorded as `native-followup` on the same `conversation_id`.

## Per-child model selection (issue #1)

`antigravity_native_start({ description, prompt, model?, effort? })`. Without `model` the child uses `nativeDefaultModel` / `nativeDefaultEffort` (default **`gemini-3.8-flash` + `high`**, the CLI's current default), validated when `agy models` works. `agy-cli` is no longer listed in DSH's model list (older children still resolve it).

- Ids come from `antigravity_models`: a base id (e.g. `gemini-3.8-flash` with `effort: low|medium|high`, default high) or a CLI variant id (e.g. `gemini-3.8-flash-low`); variant-less models (e.g. `claude-sonnet-4-6`) take no effort. Invalid combinations fail **before** the child is created.
- The choice is DSH's own `agentOptions.model / reasoningEffort`, persisted by DSH in the child descriptor and reused by `send_message` turns and cold resume.
- **Verified: agy falls back to its default model when a conversation is resumed without `--model`**, so every turn (including resumed ones) re-sends `--model/--effort`; `antigravity_followup` keeps the task's model too (an explicit new model drops the old effort).
- The trace records the requested model/effort/source; with supervision on, the hooks report the `modelName` agy actually ran (`effective`, `verified: true`), otherwise it is explicitly unverified.
- The native adapter lists `agy-cli` plus the real models in DSH.

### Picking an AGY model for a main DSH chat

Selecting an `AGY · …` model in DSH's model list runs that main session through AGY CLI too (`nativeMainSessionEnabled`, default on; off = children only):

- AGY works with **its own tools** in that session's working directory (also with `--dangerously-skip-permissions`: use trusted directories only); DSH tools are not available to it and are never faked.
- The DSH system prompt is not sent; earlier DSH tool calls/results are replaced by omission notes; an oversized first turn keeps only the newest messages that fit the CLI argument limit and says how many were dropped. Later turns continue one AGY `conversation_id`.
- **Images** (`nativeImageInput`, default on) are copied from the DSH attachment store into the system temp directory (`dsh-agy-images`, pruned after 7 days), passed with `--add-dir` and referenced by path; AGY opens them with its own viewer (verified: it identified a red/blue test image correctly).
- DSH auxiliary requests (session title, compaction) run as isolated one-shot AGY calls, outside the session's AGY conversation and without evidence collection.
- The session itself can read its execution record with `antigravity_trace` (id = session id). In a main chat each finished AGY tool step also appears as a progress line such as `> AGY · run_command … — done (0.4s)` (`nativeChatToolProgress`; children keep it in the trace only).
- **Usage**: every turn hands DSH the usage AGY itself reported. The prompt side (uncached input + cache reads) is the turn's last model call, i.e. the current context size; output and reasoning are turn totals. So tok/s, cumulative usage, cache hits and the context gauge work; cumulative input counts each turn's last call only (per-step usage is in the trace). Context capacity comes from `nativeContextWindows` (defaults: vendor model-card figures — Gemini 3.8 Flash 1,048,576, Claude 4.6 1,000,000, GPT-OSS 120B 131,072; agy reports none and AGY may compact earlier).
- **Long tasks**: one turn may run up to `nativeTimeoutMs` (default 60 min; previously the 5-minute foreground ceiling); DSH's stop button terminates the AGY process tree.

**Status:** implemented; offline tests pass; verified against real AGY in throwaway directories (`node scripts/live-chat-e2e.mjs`: image reading, continuation, title). **DSH Desktop verification pending a restart.**
- `agy models --output-format json` is not supported on 1.4.0 (contrary to the changelog), so the text listing is parsed; grouping variants into base model + efforts follows [Jonah-Wu23/dsh-agy-safe](https://github.com/Jonah-Wu23/dsh-agy-safe) (MIT).

**Status:** implemented; offline tests pass; verified against real AGY 1.4.0 in throwaway directories (`node scripts/live-models-e2e.mjs`: Claude Sonnet 4.6, Gemini 3.8 Flash Low and CLI-default children, two turns each, effective model unchanged after resume). **DSH Desktop (2026-10-17):** `antigravity_models` works; a CLI-default child and a `claude-sonnet-4-6` child in one parent session did not interfere, and a `send_message` follow-up still sent `claude-sonnet-4-6`. **Cold resume after a backend restart verified** (the same child still sent `claude-sonnet-4-6` on the same AGY conversation after the restart); inside DSH the effective model is hook-verified only with supervision on (it was off, so the trace shows the requested value).

## Sharing DSH skills with AGY (`sharedSkills`)

With `sharedSkills` (skill names, prefixes ending in `*`, or `*` for every model-invocable DSH skill) each run gets a bridge folder `~/.dsh/agy-skill-bridge/<hash>/.agents/skills.json` declaring those skills' own folders (`path` + `include_only`), passed with `--add-dir`. **Nothing is copied, linked or written into the repository or `~/.gemini`.** Verified on AGY 1.4.0: `skills.json` inside an add-dir is honored (Windows absolute paths work) and AGY opens the `SKILL.md` with `view_file` when it needs it (`node scripts/live-skills-e2e.mjs`). With supervision on, shared skill folders are readable but never writable. Skills that depend on DSH-only tools (`skill`, `ego_*`, `run_code`) cannot work inside AGY; prefer instruction/script skills, and keep the list short because names and descriptions enter AGY's context.

AGY's own ways to add skills: `~/.gemini/config/skills/<name>/SKILL.md` (global), `.agents/skills/<name>/SKILL.md` in a project, `~/.gemini/config/skills.json` declaring external folders, or `agy plugin install`; list them with `agy -p "/skills" --output-format json` (no quota).

## Collapsible execution panel (GenUI)

While a main-chat turn runs, every AGY tool step's start, finish and failure streams live as `> AGY · … — running / done / failed` (from the unified activity model: ACTIVE/DONE/ERROR of one step fold into one record, parameters and output are redacted and truncated, unknown step types keep their raw identifier); when the turn ends they are replaced by **one collapsible "AGY execution" panel** (a `dsh-ui` accordion with a timeline: tool, subject, done/failed, duration, redacted output/error preview, up to the latest 80 steps) rendered by [dsh-genui](https://github.com/omdsh-dev/dsh-genui) (`nativeChatExecutionPanel`, default on; `nativeChatPanelLanguage`: zh/en). It lists only AGY's own recorded tool steps; without dsh-genui it shows as a JSON code block. Later prompts to AGY omit these panels. GenUI's `panel:true` dock publishes only after a message settles, so it cannot update live; the panel therefore lives in the message.

**Why not a native chat card:** on DSH 0.2.0-rc.2 a third-party plugin that appends a new session event type makes the session impossible to reopen (`Session.append()` cannot mark it `ignorable`), and upstream plugin practices forbid it; a persistable plugin-record API only exists from DSH 0.2.1-rc.2. Without upgrading DSH, live progress lines plus the settled in-message panel are the equivalent UI (the panel title includes AGY's thinking-token count; the thinking itself is not available).

## Experimental: persistent AGY CLI sessions (`nativePersistentSessions`, off by default)

When enabled, every DSH session served by AGY (main chat or native child) keeps one `agy --input-format stream-json --output-format stream-json` process; each turn writes one `{"event":"user","message":{"content":"…"}}` line to stdin and completes on that turn's `result`, instead of starting the CLI per turn.

- **Reuse and restart**: the process is reused while its start options (model, effort, cwd, extra directories, supervision, permissions) stay the same; any change closes it and a new process continues the same conversation with `--conversation`. Idle processes close after `nativePersistentIdleMs` (default 10 min); all are terminated when the plugin stops. Turns of one session run in order; sessions run concurrently and stay isolated.
- **Cancel**: the protocol has no per-turn cancel, so DSH's stop button kills the process; the turn is reported cancelled (never successful) and the next turn resumes the last **completed** turn in a new process. Timeouts, unexpected exits and a missing `result` are reported as failures with the stderr tail.
- **Usage**: `num_turns`, `usage` and `duration_seconds` are cumulative; per-turn usage comes from this turn's model calls.
- **Fallback**: without `--input-format` in `agy help`, one process per turn is used; a message starting with `/` (which the CLI would treat as a slash command and end the session) runs one-shot for that turn; DSH title/compaction requests stay one-shot.
- **Inspection**: `antigravity_tasks` lists live persistent processes (PID, state, turns, conversation); every trace turn records `process pid / turn / reused`.
- **Verified (real AGY 1.4.0, throwaway directories)**: five turns on one process, live tool steps, a stopped turn followed by a new process resuming the conversation; warm persistent follow-ups median **2442 ms** vs one-shot resumed turns median **6884 ms** (3 runs each, `node scripts/live-persistent-e2e.mjs`). The cold first turn additionally pays `agy help`/`agy models` and process start-up (about 3–6 s). Not yet verified inside DSH Desktop.

## AGY thinking

AGY 1.4.0 does not expose its thinking: stream-json reports only `thinking_tokens`, and the `PostInvocation` hook payload carries no thinking field (verified). Thinking is therefore neither shown nor faked; the main-chat progress lines and `antigravity_trace` show the real execution.

## Optional supervision (AGY hooks, off by default)

With `supervisionEnabled: true` each run gets a private directory outside the repository (default `~/.dsh/agy-supervisor/<random>`) holding `.agents/hooks.json`, the hook script and a policy, passed to agy with `--add-dir`. **Nothing is written into your repository or the global agy configuration.** After the run the decisions are read back, the files re-hashed (tampering is recorded in the trace) and the directory removed.

Verified on AGY 1.4.0 (isolated directories, `-p --dangerously-skip-permissions`):
- PreToolUse `deny` **blocks the tool even with skip-permissions**; the reason shows up as a tool error in stream-json and the trace. An empty decision, malformed output, non-zero exit or timeout **also block** (fail-closed); passing requires an explicit `allow`.
- Stop `continue` + `reason` makes AGY keep working (rework); any other value lets it stop.
- `.agents/hooks.json` inside an `--add-dir` directory is loaded; hooks inherit agy's environment and run with cwd `.agents`. agy may pick that directory as the default command cwd, so the prompt names the real workspace and the hook rewrites a misplaced Cwd with `overwrite` (verified).

Built-in rules deny `git push`, wholesale discarding of git changes, package/release publishing, download-and-execute pipes, deleting a drive/home/root, system-level destructive commands, credential and agent-state locations (`~/.ssh`, `~/.gemini`, `~/.dsh`, …), writes outside the workspace, and touching the supervisor directory. Options: `supervisionDenyCommands` (extra regexes), `supervisionStopCheck` (verification command before AGY may stop; failure requests rework, bounded by `supervisionMaxReworks`), `supervisionBuiltinRules`, `supervisionDir`. Requires `skipPermissions: true`; if supervision cannot be applied the run refuses to start instead of silently running unsupervised.

This is a guardrail against mistakes, **not a security boundary**: AGY with skip-permissions has the user's file access.

**Status:** implemented, default off; offline tests pass; verified against real AGY 1.4.0 in throwaway directories (`node scripts/live-supervision-e2e.mjs`: custom rule blocked a command, an ordinary command ran, a failing stop check triggered rework until it passed, no tampering, supervisor files removed). **Not yet verified inside DSH Desktop.**

## Security

- `--dangerously-skip-permissions` is enabled by default in this plugin. **Only delegate inside a trusted and explicitly authorized repository / Git worktree**. This option bypasses normal AGY approval.
- No credential, OAuth token, API key, user profile, private task log, or `~/.dsh` state is bundled or checked into this repository.
- AGY/Google account or service terms may restrict access through third-party integration. Review applicable terms before opting in. No Google private APIs or token extraction are used.
- Task evidence is initially `review_status: pending`: the parent must review actual code changes and independently run tests.
- Experimental native adapter deliberately fails on unsupported media or native DSH tools instead of claiming to execute them.

## Development

```powershell
npm run build
node --test scripts/evidence.test.mjs scripts/plugin-smoke.test.mjs scripts/native-manager.test.mjs scripts/native-continuable.test.mjs scripts/stream-trace.test.mjs scripts/supervision.test.mjs scripts/models.test.mjs scripts/native-chat.test.mjs scripts/skills-bridge.test.mjs scripts/activity.test.mjs scripts/persistent.test.mjs
```

`npm test` additionally checks for a locally installed `agy` CLI and does not send prompts unless you explicitly run `npm run selftest:e2e` or `node scripts/live-trace-e2e.mjs` (spends AGY quota, temporary directories only).

## License and acknowledgements

MIT. Original work: [ZEM17/dsh-subagent-agy](https://github.com/ZEM17/dsh-subagent-agy). See `LICENSE`.
