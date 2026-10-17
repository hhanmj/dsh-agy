/**
 * @dsh-external/dsh-subagent-antigravity
 *
 * Product subagent provider for Google Antigravity CLI (agy), following the
 * official `dsh-subagent-codex` / `dsh-subagent-claude-code` pattern:
 * one trusted provider on `ctx.subagents` (name: `antigravity`) plus two
 * model-facing tools (`antigravity` for new tasks, `antigravity_followup`
 * for continuing a previous task).
 *
 * Every delegation spawns a fresh `agy -p <task>` process in the parent
 * session's workspace, waits for the final answer (bounded by
 * `--print-timeout` plus a local watchdog), and returns only the final text.
 * No Gemini API key is involved: agy authenticates through the user's cached
 * Antigravity login (system keyring / Google Sign-In).
 *
 * Continuation: runs use `--output-format json`, whose reply carries the
 * agy `conversation_id`; the provider records it (in-memory bridge plus a
 * durable `~/.dsh/agy-conversations.json` registry), and follow-ups spawn
 * `agy -p <prompt> --conversation <id>` so the agent's full context carries
 * over. This is agy-side session resume — it is NOT the DSH continuable
 * subagent machinery (which requires an in-process DSH child session), so
 * the follow-up is its own tool rather than `send_message`/`interrupt_agent`.
 *
 * Background mode (`background: true`): the run registers with the generic
 * `ctx.jobs` runtime and returns a job id immediately. It spawns agy with
 * `--output-format stream-json` (probe-gated) and streams the incremental
 * `text_delta` chunks through the job's `readOutput`, so `job_output`
 * returns live progress and `job_kill` stops it; the final read carries a
 * `[task: ...]` line so the conversation can still be followed up.
 *
 * Robustness notes:
 * - Supported agy flags are probed once per provider instance (`agy help`),
 *   so `--output-format` / `--conversation` / `--sandbox` / `--add-dir` /
 *   `stream-json` are only emitted when the installed build understands them.
 * - A local watchdog (printTimeoutMs + watchdogMarginMs) terminates a hung
 *   agy tree instead of waiting forever.
 * - The follow-up registry is written atomically (tmp + rename) and all
 *   writes are serialized through a module-level queue, so concurrent tool
 *   calls cannot clobber each other.
 * - The registry self-heals: a corrupt or wrongly-shaped file is backed up
 *   once (`*.corrupt`, mtime-guarded) and reset instead of being silently
 *   overwritten by the next save; malformed entries are dropped with a
 *   warning; and the read-modify-write cycles themselves are serialized, so
 *   concurrent runs cannot lose each other's records.
 * - A tasks/cancel layer (`antigravity_tasks` / `antigravity_cancel`) lists
 *   in-flight runs plus durable history (restart-safe) and can stop a
 *   running agy; all in-flight runs are terminated on plugin stop/update.
 * - Follow-ups to the SAME conversation are serialized per conversation id,
 *   so two concurrent prompts cannot corrupt one agy conversation file.
 * - Prompts are capped at MAX_ARGV_PROMPT_CHARS for argv safety.
 *
 * Process lifecycle is owned by the shared `ctx.subprocess` seam (credential
 * scrubbing, tree-scoped SIGTERM→SIGKILL escalation, whole-tree exit), and
 * result settlement follows the out-of-process subagent contract
 * (`settleRunResult` + `subprocessRunHandle`): `result` never rejects.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  NO_START_CAPABILITIES,
  assertPositiveFinite,
  resolveChildCwd,
  settleRunResult,
  subprocessRunHandle,
  validateConfiguredCwd,
  type ResolvedSubagentStartRequest,
  type SubagentProvider,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import { scrubbedParentEnv, type SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type ContentBlock, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { createHash, randomUUID } from 'node:crypto'
import { NativeAgyLlmAdapter, NATIVE_MODEL_ID, nativePrompt, type NativeTextSink } from './native-bridge.js'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { captureWorkspace, classifyBackgroundTermination, collectEvidence, readEvidence, saveEvidence, type ExecutionStatus, type TaskEvidence } from './evidence.js'
import { AgyStreamAccumulator, NdjsonLineSplitter, errorText, parseAgyErrorLine, parseAgyStreamLine, type AgyStreamEvent } from './stream-events.js'
import {
  DEFAULT_TRACE_LIMITS,
  RunTraceRecorder,
  TraceStore,
  recordEvidence,
  renderTraceRecord,
  sanitizeText,
  summarizeTrace,
  type TraceKind,
  type TraceRecord,
  type TraceSummary,
  type TraceTransport,
} from './trace.js'
import { prepareSupervisor, supervisionPromptNote, supervisorDirFor, type SupervisionReport, type SupervisorHandle } from './supervision.js'
import { AgyModelCatalog, AgyModelSelectionError, EFFORT_ORDER, defaultEffortFor, resolveSelection, type AgyBaseModel } from './models.js'
import { fileURLToPath } from 'node:url'

export const name = '@dsh-external/dsh-subagent-agy-reviewed'
export const inject = ['subagents', 'subprocess', 'tools', 'llm', 'agents']

/** Register the `antigravity` job kind with the generic jobs registry (id prefix: `antigravity-N`). */
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    antigravity: 'antigravity'
  }
}

const PREFIX = 'subagent-antigravity'
/** In-memory stdout tail cap (1 MiB); overflow spills to a file (64 MiB). */
const MAX_STDOUT_BYTES = 1 << 20
const MAX_STDOUT_SPILL_BYTES = 64 << 20
/** stderr stays a bounded diagnostic tail. */
const MAX_STDERR_BYTES = 64 << 10
/** Background live-output window cap (8 MiB): old deltas drop so a long run cannot grow memory unboundedly. */
const MAX_VISIBLE_BYTES = 8 << 20
/** Durable follow-up registry cap. */
const MAX_TASK_RECORDS = 50
/** In-memory run bridge cap. */
const MAX_RUN_RECORDS = 64
/**
 * Prompts longer than this are NOT passed as one argv element. Windows
 * `CreateProcess` caps the whole command line near 32767 chars; keep a
 * margin for the generated flags. agy has no `--prompt-file` today, so the
 * provider refuses oversized prompts with guidance instead of a silent
 * truncation (if a future agy adds the flag, the probe auto-enables it).
 */
const MAX_ARGV_PROMPT_CHARS = 30_000
/** Bound for the one-time `agy help` flag probe. */
const PROBE_TIMEOUT_MS = 10_000
/** Bound for one `agy models` listing. */
const MODELS_TIMEOUT_MS = 30_000
/**
 * Appended to every prompt when `avoidBrowser` is on: agy's headless
 * `browser_*` tools can hang indefinitely (browser launch / page load never
 * completing) and freeze the run with no output.
 */
const AVOID_BROWSER_SUFFIX =
  '\n\n(Environment note: headless browser tools are unreliable in this environment and can hang the run indefinitely. Do NOT use browser_* tools, do NOT open URLs in a browser, and do NOT wait on page loads. Verify pages and UI by reading the source files and running commands instead.)'
/**
 * Appended to every prompt when `avoidLargeReads` is on: agy's file-read
 * tool fails above its 4 MB cap, so large files must be inspected through
 * targeted commands instead of being read whole.
 */
const AVOID_LARGE_READ_SUFFIX =
  '\n\n(Environment note: files larger than 1 MB must NOT be read with your file-read tool — it fails above 4 MB, which large files like single-file components with embedded assets easily exceed. Inspect large files with grep, sed, head, tail, or python via run_command instead: first probe structure with head/grep, then extract only the slices you need. Never read a file whole when it is larger than 1 MB.)'

export const Config = z.object({
  /** Registry name on `ctx.subagents`. */
  providerName: z.string().default('antigravity'),
  /** New-task tool name. */
  toolName: z.string().default('antigravity'),
  /** Follow-up tool name. */
  followupToolName: z.string().default('antigravity_followup'),
  /** Executable to resolve (bare name on PATH or absolute path). */
  command: z.string().default('agy'),
  /** `--model <slug>`; empty omits the flag (agy's default model). */
  model: z.string().default(''),
  /** `--effort`; low | medium | high | xhigh | max; empty omits the flag. */
  effort: z.string().default(''),
  /** `--agent <name>`; empty omits the flag. */
  agent: z.string().default(''),
  /** Ceiling for one headless run (`--print-timeout`); agy's own default is 5m. */
  printTimeoutMs: z.number().step(1).min(1000).max(3_600_000).default(5 * 60 * 1000),
  /**
   * Local watchdog margin on top of the active ceiling (foreground
   * `printTimeoutMs`, background `backgroundTimeoutMs`). If agy neither
   * finishes nor honors its own `--print-timeout` (network hang, auth
   * stall), the plugin terminates the process tree after ceiling + margin.
   */
  watchdogMarginMs: z.number().step(1).min(5_000).max(600_000).default(60_000),
  /**
   * Ceiling for BACKGROUND runs (`--print-timeout`); the foreground ceiling
   * stays `printTimeoutMs`. Long tasks belong in the background, where the
   * model watches progress via job_output and is notified on completion, so
   * this ceiling can be generous; the watchdog margin applies on top and
   * `job_kill` stops a run at any time.
   */
  backgroundTimeoutMs: z.number().step(1).min(1000).max(3_600_000).default(3_600_000),
  /**
   * `--dangerously-skip-permissions`: auto-approve all agy tool calls.
   * Headless agy cannot prompt for approval, so unattended real work
   * (file edits, commands) needs this on.
   */
  skipPermissions: z.boolean().default(true),
  /** `--sandbox`: run with agy's terminal sandbox restrictions. */
  sandbox: z.boolean().default(false),
  /**
   * Append a browser-avoidance instruction to every agy prompt. agy's
   * headless `browser_*` tools can hang indefinitely in this environment
   * (browser launch / page load never completing), which freezes the whole
   * run with no output. Default true: agy verifies pages by reading files
   * and running commands instead. Set false only for tasks that genuinely
   * need a browser preview.
   */
  avoidBrowser: z.boolean().default(true),
  /**
   * Append a large-file reading strategy instruction to every agy prompt:
   * files above 1 MB must NOT be read with agy's file-read tool (it fails
   * above its 4 MB cap — e.g. single-file components with embedded assets);
   * they must be inspected via grep/sed/head/tail/python through
   * run_command instead. Guidance, not enforcement: the plugin cannot
   * intercept agy's internal tool calls.
   */
  avoidLargeReads: z.boolean().default(true),
  /**
   * When a run fails with an authentication error, automatically pop up
   * agy's interactive login window (a new console running `agy`, which
   * opens the Google sign-in flow) so the user can authenticate on the
   * spot; the error message notes that a window was opened. Windows only
   * (other platforms get instructions). Disable for headless deployments.
   */
  autoLoginWindow: z.boolean().default(true),
  /** Model-facing tool name for the manual login-window opener. */
  loginToolName: z.string().default('antigravity_login'),
  /**
   * Launch the interactive login window minimized (taskbar icon only, no
   * full black console) instead of a normal window. The TUI still works —
   * click the taskbar icon to open it when the browser flow needs input.
   */
  loginWindowMinimized: z.boolean().default(true),
  /** Model-facing tool name for listing tasks (running + recent registry history). */
  tasksToolName: z.string().default('antigravity_tasks'),
  /** Model-facing tool name for stopping a running task by its task key. */
  cancelToolName: z.string().default('antigravity_cancel'),
  /** Read locally collected change evidence for review; no child-model claims are trusted. */
  evidenceToolName: z.string().default('antigravity_evidence'),
  /** Optional evidence storage directory; empty uses ~/.dsh/agy-evidence. */
  evidenceDir: z.string().default(''),
  /**
   * Wire output format for foreground runs. `json` is preferred: it returns
   * the agy `conversation_id` (required for follow-ups) plus a
   * machine-readable status/response, and it does not suffer the non-TTY
   * stdout drop. Background runs automatically prefer `stream-json` (live
   * progress) when the installed build supports it. If the installed agy
   * build rejects the flag (detected by a one-time probe), the provider
   * automatically falls back to text mode.
   */
  outputFormat: z.union([z.const('json'), z.const('text')]).default('json'),
  /** Raw extra argv appended after every generated flag (advanced). */
  extraArgs: z.array(z.string()).default([]),
  /** Working-directory override; empty uses the delegating session's cwd. */
  cwd: z.string().default(''),
  /**
   * Extra directories to add to the agy workspace (`--add-dir`, repeatable).
   * Use absolute paths to targets OUTSIDE the session workspace: headless agy
   * cannot answer the interactive "add directory to workspace?" prompt, so
   * without this flag a task touching such a directory hangs until
   * `--print-timeout` fires.
   */
  addDirs: z.array(z.string()).default([]),
  /** Explicit environment overlay for the agy process (merged after the harness scrub). */
  env: z.dict(z.string()).default({}),
  /**
   * Proxy URL for the agy child (e.g. `http://127.0.0.1:7897`). Empty falls
   * back to the `AGY_PROXY` host env var, then to the first line of
   * `~/.dsh/agy-proxy.txt` (re-read on every call — write it to change the
   * proxy without a rebuild or restart). Google rejects Antigravity API
   * requests from unsupported regions with `User location is not supported`,
   * so a supported-region egress is required there.
   */
  proxy: z.string().default(''),
  /** Durable follow-up registry path; empty derives `~/.dsh/agy-conversations.json`. */
  registryPath: z.string().default(''),
  /** Experimental true DSH continuable child (off by default, AGY CLI text-only transport). */
  nativeContinuableEnabled: z.boolean().default(false),
  nativeLlmProvider: z.string().default('agy-native-cli'),
  nativeStartToolName: z.string().default('antigravity_native_start'),
  /** Dedicated native child id -> AGY conversation index; never bundled/published. */
  nativeRegistryPath: z.string().default(''),
  /**
   * Let a main DSH session that selects an AGY model in DSH's model list use
   * the native transport too (AGY works with its own tools in that session's
   * cwd; DSH tools are not available to it). Off: only child sessions.
   */
  nativeMainSessionEnabled: z.boolean().default(true),
  /** Accept image input: images are copied to a temp directory and opened by AGY with its own file viewer. */
  nativeImageInput: z.boolean().default(true),
  /** Model for children/sessions that do not choose one (validated against "agy models"). Empty: the CLI's own default. */
  nativeDefaultModel: z.string().default('gemini-3.8-flash'),
  /** Effort for nativeDefaultModel when it has effort variants. */
  nativeDefaultEffort: z.string().default('high'),
  /** Ceiling for one native AGY turn (child or main chat): long coding turns run many AGY tool steps. */
  nativeTimeoutMs: z.number().step(1).min(60_000).max(6 * 3_600_000).default(3_600_000),
  /** Show AGY's own tool steps as short progress lines in a MAIN chat (children report them only in the trace). */
  nativeChatToolProgress: z.boolean().default(true),
  /**
   * Context capacity advertised to DSH per base model id (tokens). agy reports
   * none; defaults are vendor model-card figures (as compiled by the MIT
   * project Jonah-Wu23/dsh-agy-safe) and AGY may compact earlier.
   */
  nativeContextWindows: z.dict(z.number()).default({
    'gemini-3.8-flash': 1_048_576,
    'claude-sonnet-4-6': 1_000_000,
    'claude-opus-4-6-thinking': 1_000_000,
    'gpt-oss-120b': 131_072,
  }),
  /** Grace period for tree-scoped termination (SIGTERM→SIGKILL escalation). */
  disposeGraceMs: z.number().step(1).min(100).max(120_000).default(5_000),
  /**
   * Durable execution trace from agy `--output-format stream-json` events
   * (AGY steps, AGY-internal tool calls, results, evidence links). When on,
   * runs use stream-json whenever the installed build supports it.
   */
  traceEnabled: z.boolean().default(true),
  /** Trace directory; empty uses ~/.dsh/agy-traces (never inside a repository). */
  traceDir: z.string().default(''),
  /** Model-facing trace query tool name. */
  traceToolName: z.string().default('antigravity_trace'),
  /** Per-trace record cap (step records past it are dropped; lifecycle records are kept). */
  traceMaxEvents: z.number().step(1).min(100).max(100_000).default(DEFAULT_TRACE_LIMITS.maxEventsPerTrace),
  /** Number of trace files kept (oldest are rotated out). */
  traceMaxFiles: z.number().step(1).min(10).max(10_000).default(DEFAULT_TRACE_LIMITS.maxTraces),
  /**
   * Opt-in supervision through agy's own command hooks, injected per run with
   * --add-dir (nothing is written into the workspace or global agy config).
   * PreToolUse denies dangerous commands, credential/agent-state paths and
   * writes outside the workspace; denials block even with skip-permissions.
   * Requires skipPermissions; a run refuses to start if supervision cannot be applied.
   */
  supervisionEnabled: z.boolean().default(false),
  /** Built-in command rules (git push, destructive git, publish, curl|sh, root deletes, system commands). */
  supervisionBuiltinRules: z.boolean().default(true),
  /** Extra case-insensitive regular expressions; matching run_command lines are denied. */
  supervisionDenyCommands: z.array(z.string()).default([]),
  /** Optional verification command run when AGY tries to stop; a non-zero exit asks AGY to rework. */
  supervisionStopCheck: z.string().default(''),
  supervisionStopCheckTimeoutMs: z.number().step(1).min(1000).max(600_000).default(120_000),
  /** Upper bound for automatic rework rounds triggered by a failing stop check. */
  supervisionMaxReworks: z.number().step(1).min(0).max(10).default(2),
  /** Directory for per-run supervisor files; empty uses ~/.dsh/agy-supervisor. */
  supervisionDir: z.string().default(''),
  /** Model-facing read-only tool listing the models "agy models" reports. */
  modelsToolName: z.string().default('antigravity_models'),
  /**
   * DSH skills AGY may use: exact names, prefix patterns ending in *, or * for
   * every model-invocable DSH skill. Each run gets a bridge directory whose
   * .agents/skills.json points AGY at the skills' own folders (--add-dir); nothing
   * is copied into the repository or ~/.gemini. Skills that need DSH-only tools
   * will not work inside AGY.
   */
  sharedSkills: z.array(z.string()).default([]),
  /** Directory for skills.json bridge folders; empty uses ~/.dsh/agy-skill-bridge. */
  sharedSkillsDir: z.string().default(''),
})

/** Runtime config after schemastery defaults. */
export interface Config {
  providerName: string
  toolName: string
  followupToolName: string
  command: string
  model: string
  effort: string
  agent: string
  printTimeoutMs: number
  watchdogMarginMs: number
  backgroundTimeoutMs: number
  skipPermissions: boolean
  sandbox: boolean
  avoidBrowser: boolean
  avoidLargeReads: boolean
  autoLoginWindow: boolean
  loginToolName: string
  loginWindowMinimized: boolean
  tasksToolName: string
  cancelToolName: string
  evidenceToolName: string
  evidenceDir: string
  outputFormat: 'json' | 'text'
  extraArgs: string[]
  cwd: string
  addDirs: string[]
  env: Record<string, string>
  proxy: string
  registryPath: string
  nativeContinuableEnabled: boolean
  nativeLlmProvider: string
  nativeStartToolName: string
  nativeRegistryPath: string
  nativeMainSessionEnabled: boolean
  nativeImageInput: boolean
  nativeDefaultModel: string
  nativeDefaultEffort: string
  nativeTimeoutMs: number
  nativeChatToolProgress: boolean
  nativeContextWindows: Record<string, number>
  disposeGraceMs: number
  traceEnabled: boolean
  traceDir: string
  traceToolName: string
  traceMaxEvents: number
  traceMaxFiles: number
  supervisionEnabled: boolean
  supervisionBuiltinRules: boolean
  supervisionDenyCommands: string[]
  supervisionStopCheck: string
  supervisionStopCheckTimeoutMs: number
  supervisionMaxReworks: number
  supervisionDir: string
  modelsToolName: string
  sharedSkills: string[]
  sharedSkillsDir: string
}

/** One durable task entry: the agy conversation a follow-up resumes. */
export interface TaskRecord {
  conversationId: string
  cwd: string
  label: string
  createdAt: number
  /**
   * --model / --effort this conversation last ran with. agy falls back to its
   * default model when a conversation is resumed without --model, so
   * follow-ups re-send these unless the caller overrides them.
   */
  model?: string
  effort?: string
}

/** Minimal logger shape for registry persistence (ctx.logger is assignable). */
export interface RegistryLogger {
  warn(message: string): void
}

/** Base directory for plugin-owned files: DSH_HOME, else `~/.dsh`. */
function pluginBaseDir(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0) return process.env.DSH_HOME
  return home !== undefined ? join(home, '.dsh') : ''
}

/** Resolve the proxy URL for the agy child: config → AGY_PROXY env → ~/.dsh/agy-proxy.txt. */
function resolveProxyUrl(config: Config): string {
  if (config.proxy.length > 0) return config.proxy
  const envProxy = process.env.AGY_PROXY
  if (envProxy !== undefined && envProxy.length > 0) return envProxy
  try {
    const base = pluginBaseDir()
    if (base.length === 0) return ''
    const text = readFileSync(join(base, 'agy-proxy.txt'), 'utf8').trim()
    return text.length > 0 ? text : ''
  } catch {
    return ''
  }
}

/** Apply the resolved proxy to a child environment (upper+lower variants, Go/npm convention). */
function applyProxyEnv(env: Record<string, string>, proxy: string): void {
  if (proxy.length === 0) return
  env.HTTP_PROXY = proxy
  env.HTTPS_PROXY = proxy
  env.ALL_PROXY = proxy
  env.http_proxy = proxy
  env.https_proxy = proxy
  env.all_proxy = proxy
  if (env.NO_PROXY === undefined && env.no_proxy === undefined) {
    env.NO_PROXY = 'localhost,127.0.0.1,::1'
  }
}

/** Durable follow-up registry (task key = the DSH run id). */
export function registryFilePath(config: Config): string {
  if (config.registryPath.length > 0) return config.registryPath
  return join(pluginBaseDir(), 'agy-conversations.json')
}

function registryDir(base: string): string {
  const dir = dirname(base)
  return dir.length === 0 ? '.' : dir
}

/** Back up a corrupt registry file once per corruption event (mtime guard), then reset. */
function backupCorruptRegistry(file: string, rawText: string, warn: (message: string) => void): void {
  if (rawText.trim().length === 0) return
  const backup = `${file}.corrupt`
  try {
    const backupStat = statSync(backup)
    const fileStat = statSync(file)
    if (backupStat.mtimeMs >= fileStat.mtimeMs) {
      warn(
        `${PREFIX}: task registry ${file} is corrupt (${rawText.length} bytes) — the previous content is preserved at ${backup}; the registry restarts fresh`,
      )
      return
    }
  } catch {
    // no backup yet — write one below
  }
  try {
    writeFileSync(backup, rawText, 'utf8')
    warn(`${PREFIX}: task registry ${file} is corrupt (${rawText.length} bytes) — original backed up to ${backup}; the registry restarts fresh`)
  } catch (error) {
    warn(`${PREFIX}: task registry ${file} is corrupt (${rawText.length} bytes) and could not be backed up: ${String(error)}`)
  }
}

/**
 * Load the durable follow-up registry, self-healing on damage: a missing
 * file is a normal fresh state; a corrupt or wrongly-shaped file is backed
 * up once (`.corrupt`, guarded by mtime) instead of being silently
 * overwritten by the next save; malformed entries are dropped with a
 * warning. A crash or hand-edit can never silently wipe the history.
 */
export function loadTaskRegistry(config: Config, logger?: RegistryLogger): Record<string, TaskRecord> {
  const file = registryFilePath(config)
  const warn = logger?.warn ?? ((message: string) => console.warn(message))
  let rawText: string
  try {
    rawText = readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    backupCorruptRegistry(file, rawText, warn)
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    backupCorruptRegistry(file, rawText, warn)
    return {}
  }
  const records: Record<string, TaskRecord> = {}
  let dropped = 0
  for (const [key, value] of Object.entries(parsed)) {
    const entry = value as Partial<TaskRecord> | null | undefined
    if (
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.conversationId === 'string' &&
      entry.conversationId.length > 0 &&
      typeof entry.cwd === 'string' &&
      typeof entry.createdAt === 'number' &&
      Number.isFinite(entry.createdAt)
    ) {
      records[key] = {
        conversationId: entry.conversationId,
        cwd: entry.cwd,
        label: typeof entry.label === 'string' ? entry.label : '',
        createdAt: entry.createdAt,
        ...(typeof entry.model === 'string' && entry.model.length > 0 ? { model: entry.model } : {}),
        ...(typeof entry.effort === 'string' && entry.effort.length > 0 ? { effort: entry.effort } : {}),
      }
    } else {
      dropped += 1
    }
  }
  if (dropped > 0) warn(`${PREFIX}: dropped ${dropped} malformed entry(ies) from task registry ${file}`)
  return records
}

/** Trim to the newest MAX_TASK_RECORDS entries and write atomically (tmp + rename). */
function doSaveRegistry(config: Config, records: Record<string, TaskRecord>): void {
  const entries = Object.entries(records)
    .sort((a, b) => (b[1]?.createdAt ?? 0) - (a[1]?.createdAt ?? 0))
    .slice(0, MAX_TASK_RECORDS)
  const trimmed: Record<string, TaskRecord> = {}
  for (const [key, record] of entries) trimmed[key] = record
  const base = registryFilePath(config)
  const dir = registryDir(base)
  mkdirSync(dir, { recursive: true })
  const tmp = join(
    dir,
    `.agy-conv-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  )
  try {
    writeFileSync(tmp, JSON.stringify(trimmed, null, 2), 'utf8')
    renameSync(tmp, base)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

/**
 * Serialize every registry write through one module-level queue so
 * concurrent tool calls cannot read-modify-write over each other. The write
 * itself is atomic (tmp + rename), so a crash mid-write never corrupts the
 * registry. Persistence is best-effort: a failed write only loses future
 * follow-ups.
 */
let registryTail: Promise<void> = Promise.resolve()
export function saveTaskRegistry(config: Config, records: Record<string, TaskRecord>, logger?: RegistryLogger): Promise<void> {
  const run = registryTail.then(() => {
    try {
      doSaveRegistry(config, records)
    } catch (error) {
      const warn = logger?.warn ?? ((message: string) => console.warn(message))
      warn(`${PREFIX}: failed to persist task registry: ${String(error)}`)
    }
  })
  registryTail = run
  return run
}

/**
 * Atomically read-modify-write the durable registry through the same
 * serialization queue as {@link saveTaskRegistry}: concurrent tool calls
 * (e.g. a foreground and a background run finishing at the same time) can
 * no longer lose each other's records to a stale read-modify-write race.
 * The write itself is atomic (tmp + rename) and failures are contained
 * (best-effort persistence, like saveTaskRegistry).
 */
export function updateTaskRegistry(
  config: Config,
  mutate: (records: Record<string, TaskRecord>) => void,
  logger?: RegistryLogger,
): Promise<void> {
  const run = registryTail.then(() => {
    try {
      const records = loadTaskRegistry(config, logger)
      mutate(records)
      doSaveRegistry(config, records)
    } catch (error) {
      const warn = logger?.warn ?? ((message: string) => console.warn(message))
      warn(`${PREFIX}: failed to persist task registry: ${String(error)}`)
    }
  })
  registryTail = run
  return run
}

/** Extract the joined text of a prompt's text blocks. */
function textOfPrompt(prompt: readonly { type: string; text?: string }[]): string {
  return prompt
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
}

/** Wrap text as one canonical text ContentBlock, or [] when empty. */
function textBlocks(text: string): { type: 'text'; text: string }[] {
  return text.length === 0 ? [] : [{ type: 'text', text }]
}

/** agy `--output-format json` replies, or undefined when stdout is not JSON. */
interface AgyJsonReply {
  conversation_id?: string
  status?: string
  response?: string
  error?: string
}

/** Parse one candidate JSON object if it looks like an agy reply. */
function parseJsonObject(text: string): AgyJsonReply | undefined {
  try {
    const obj = JSON.parse(text) as unknown
    if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
      const reply = obj as AgyJsonReply
      if ('status' in reply || 'conversation_id' in reply || 'response' in reply) return reply
    }
  } catch {
    // not JSON
  }
  return undefined
}

/**
 * Find the agy JSON reply in stdout: try the whole trimmed output first,
 * then scan line by line so a preamble (progress/status line before the
 * JSON object) cannot hide the `conversation_id`.
 */
function tryParseJsonOutput(stdout: string): AgyJsonReply | undefined {
  const trimmed = stdout.trim()
  if (trimmed.length > 0 && trimmed[0] === '{') {
    const whole = parseJsonObject(trimmed)
    if (whole !== undefined) return whole
  }
  for (const line of stdout.split(/\r?\n/)) {
    const candidate = line.trim()
    if (candidate.length === 0 || candidate[0] !== '{') continue
    const parsed = parseJsonObject(candidate)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

/** True when agy rejected a flag it does not define (older builds). */
function isUnknownFlagError(stderr: string): boolean {
  return /flag provided but not defined|unknown flag|not defined: -output-format/i.test(stderr)
}

/** True when the detail smells like a missing/expired login. */
function isAuthError(detail: string): boolean {
  return /authentication required|not logged in|please (log|sign) in|login required|unauthenticated/i.test(detail)
}

/** Append an actionable authentication hint when the detail smells like a missing login. */
function authHintFor(detail: string): string {
  if (!isAuthError(detail)) return detail
  return `${detail}\nHint: authenticate once by running \`agy\` interactively (agy → login), or set ANTIGRAVITY_API_KEY.`
}

/** Cooldown between automatic login-window launches (avoid popup storms). */
const LOGIN_LAUNCH_COOLDOWN_MS = 15_000
let lastLoginLaunchAt = 0

/** Result of the one-time `agy help` flag probe. `probed` false = probe failed, assume standard flags. */
interface AgyFlagSupport {
  outputFormat: boolean
  conversation: boolean
  sandbox: boolean
  addDir: boolean
  promptFile: boolean
  streamJson: boolean
  probed: boolean
}

/** Probe failed (agy absent/help not parseable): keep the historic behavior for real flags, never invent --prompt-file. */
const UNKNOWN_FLAG_SUPPORT: AgyFlagSupport = {
  outputFormat: true,
  conversation: true,
  sandbox: true,
  addDir: true,
  promptFile: false,
  streamJson: true,
  probed: false,
}

/** Parse flag support out of `agy help` usage text (exit code is unreliable: `--help` itself is an unknown flag). */
function parseFlagSupport(text: string): AgyFlagSupport {
  const has = (flag: string): boolean => new RegExp(`--${flag}(?:\\s|=)`).test(text)
  return {
    outputFormat: has('output-format'),
    conversation: has('conversation'),
    sandbox: has('sandbox'),
    addDir: has('add-dir'),
    promptFile: has('prompt-file'),
    // `stream-json` is a VALUE of `--output-format` (not a flag), so match the bare word.
    streamJson: /\bstream-json\b/.test(text),
    probed: has('print') || has('conversation'),
  }
}

/**
 * Validate `--add-dir` entries: absolute, existing, real directories. Fail
 * BEFORE the spawn — a wrong path would otherwise cost agy a full
 * `--print-timeout` hang instead of an immediate clear error.
 */
function validateAddDirs(prefix: string, dirs: readonly string[], source: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of dirs) {
    const dir = raw.trim()
    if (dir.length === 0) continue
    if (!isAbsolute(dir)) {
      throw new Error(`${prefix}: addDirs[${source}] must be an absolute path (got "${dir}")`)
    }
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(dir)
    } catch {
      throw new Error(`${prefix}: addDirs[${source}] does not exist: ${dir}`)
    }
    if (!stat.isDirectory()) {
      throw new Error(`${prefix}: addDirs[${source}] is not a directory: ${dir}`)
    }
    if (!seen.has(dir)) {
      seen.add(dir)
      out.push(dir)
    }
  }
  return out
}

/** Per-task options carried only through the DSH subagent manager into this provider. */
export interface AgyNativeOptions {
  cwd?: string
  model?: string
  effort?: string
  dirs?: string[]
  background?: boolean
  conversationId?: string
  /** Trace to append to (follow-ups continue the original task's trace). */
  traceKey?: string
}

/** How one run is observed: which trace it belongs to and who receives live text. */
export interface AgyRunStreamOptions {
  /** Trace key; defaults to the run id (task key). Native children use their child id. */
  traceKey?: string
  traceKind?: TraceKind
  /** DSH Agent/Session id allowed to read the trace; defaults to the request parent. */
  owner?: string | null
  childId?: string
  /** Free-form run mode label recorded in run_start. */
  mode?: string
  /** Receives AGY's real visible text deltas while the run executes. */
  onText?: (delta: string) => void
  /** Receives every decoded stream-json event (usage, tool steps) while the run executes. */
  onEvent?: (event: AgyStreamEvent) => void
}
/** Per-run options shared by runOnce entry points. */
export interface AgyRunOptions {
  cwd?: string
  model?: string
  effort?: string
  stream?: AgyRunStreamOptions
  /** Extra --add-dir directories for this run (follow-ups; startWithDirs takes them positionally). */
  dirs?: string[]
  /** Run ceiling override (defaults to printTimeoutMs). */
  timeoutMs?: number
}
export type AgyNativeRequest = SubagentStartRequest & { agyOptions: AgyNativeOptions }
export type AgyManagedBackgroundRun = SubagentRun & {
  agyBackground: {
    cancel: (reason?: string) => void
    done: AntigravityBackgroundHandle['done']
    output: ReturnType<typeof backgroundOutputSource>
  }
}
/** Runtime type guard — native one-shot manager retains the provider's run handle. */
export function hasAgyBackground(run: SubagentRun): run is AgyManagedBackgroundRun {
  return 'agyBackground' in run && run.agyBackground !== null && typeof run.agyBackground === 'object'
}

/** The seam request shape the follow-up tool hands to the provider directly. */
export interface FollowupRequest {
  label?: string
  prompt: ContentBlock[]
  parent: Agent
  signal: AbortSignal
}

/** Hooks shape registered with `ctx.jobs` for a background agy run (mirrors dsh-tool-pwsh's background adaptation). */
export interface AntigravityBackgroundHandle {
  /** Same id saved in background evidence and follow-up registry. */
  id: SessionId
  /** Stop the run (job_kill). */
  cancel: (reason?: string) => void
  /** Settles with the generic task-outcome vocabulary. */
  done: Promise<{ status: 'killed' | 'completed' | 'failed'; detail: string }>
  /** Incremental output delta since the previous read. */
  readOutput: () => string
}
/**
 * DSH Jobs 0.2 pumps a byte-offset source into its output ring; Jobs 0.1
 * previously called a destructive readOutput() hook instead. Buffer reads so
 * polling and the final drain never lose streamed AGY text or the task key.
 */
export function backgroundOutputSource(readOutput: () => string): {
  read(fromByte: number): { text: string; nextOffset: number; lossy: boolean }
} {
  let retained = Buffer.alloc(0)
  let totalBytes = 0
  let baseByte = 0
  return {
    read(fromByte: number) {
      const next = readOutput()
      if (next.length > 0) {
        const chunk = Buffer.from(next, 'utf8')
        retained = Buffer.concat([retained, chunk])
        totalBytes += chunk.length
        if (retained.length > MAX_VISIBLE_BYTES) {
          const drop = retained.length - MAX_VISIBLE_BYTES
          retained = retained.subarray(drop)
          baseByte += drop
        }
      }
      const lossy = fromByte < baseByte
      const bounded = Math.max(baseByte, Math.min(Math.max(0, fromByte), totalBytes))
      return { text: retained.subarray(bounded - baseByte).toString('utf8'), nextOffset: totalBytes, lossy }
    },
  }
}


/** One in-flight run tracked for the tasks/cancel tool layer (foreground or background). */
export interface ActiveRunInfo {
  label: string
  cwd: string
  startedAt: number
  background: boolean
  cancel: () => void
  /** Trace this run appends to, when tracing is on. */
  traceKey?: string
}

/** Live stream-json decoding attached to one piped stdout. */
interface LiveStream {
  acc: AgyStreamAccumulator
  /** Resolves once stdout ended and every complete line was consumed. */
  drained: Promise<void>
}

/** Decode a piped stdout as stream-json; each parsed event goes to the accumulator, then `onEvent`. */
function attachStream(stdout: NodeJS.ReadableStream | undefined, onEvent: (event: AgyStreamEvent) => void): LiveStream {
  const splitter = new NdjsonLineSplitter()
  const acc = new AgyStreamAccumulator()
  const feed = (lines: string[]): void => {
    for (const line of lines) {
      const event = parseAgyStreamLine(line)
      acc.apply(event)
      try {
        onEvent(event)
      } catch {
        // observers never break the transport
      }
    }
  }
  const drained = new Promise<void>((resolve) => {
    if (stdout === undefined) {
      resolve()
      return
    }
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      feed(splitter.end())
      resolve()
    }
    stdout.on('data', (chunk: Buffer | string) => feed(splitter.push(chunk)))
    stdout.once('end', finish)
    stdout.once('close', finish)
    stdout.once('error', finish)
  })
  return { acc, drained }
}

/** Remove subdirectories of `root` untouched for longer than `maxAgeMs` (best effort). */
function pruneOldDirectories(root: string, maxAgeMs: number): void {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of names) {
    const dir = join(root, name)
    try {
      if (now - statSync(dir).mtimeMs > maxAgeMs) rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

/** Wait for `promise`, but never longer than `ms`. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    promise.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
    }),
  ])
  clearTimeout(timer)
}

function homeDirectory(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? homedir()
}

function agentIdOf(agent: unknown): string | null {
  const id = (agent as { id?: unknown } | null | undefined)?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/**
 * DSH token usage for one AGY turn from AGY's own numbers. A DSH request is one
 * AGY turn made of several model calls: the prompt side (uncached input +
 * cache reads) is the LAST call's, which is the conversation's current
 * context size (what DSH's context gauge shows); output and reasoning are the
 * turn totals (what was generated). Nothing is estimated: with no reported
 * usage, none is emitted.
 */
class TurnUsage {
  private lastCall: { input_tokens?: number; cache_read_tokens?: number } | undefined
  private total: { input_tokens?: number; output_tokens?: number; thinking_tokens?: number; cache_read_tokens?: number } | undefined

  readonly observe = (event: AgyStreamEvent): void => {
    if (event.kind === 'step' && event.stepType === 'agent_response' && event.usage !== undefined) this.lastCall = event.usage
    if (event.kind === 'result' && event.usage !== undefined) this.total = event.usage
  }

  toDsh(): { usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; reasoningTokens?: number } } {
    const prompt = this.lastCall ?? this.total
    const output = this.total?.output_tokens
    if (prompt?.input_tokens === undefined || output === undefined) return {}
    return {
      usage: {
        inputTokens: prompt.input_tokens,
        outputTokens: output,
        ...(prompt.cache_read_tokens !== undefined ? { cacheReadTokens: prompt.cache_read_tokens } : {}),
        ...(this.total?.thinking_tokens !== undefined ? { reasoningTokens: this.total.thinking_tokens } : {}),
      },
    }
  }
}

/** One short, redacted line per finished AGY tool step for a main chat (not a DSH tool call). */
function chatProgressLine(event: AgyStreamEvent): string | undefined {
  if (event.kind !== 'step' || (event.stepType !== 'tool' && event.toolInfo === undefined)) return undefined
  const state = event.state ?? ''
  if (state !== 'DONE' && state !== 'ERROR') return undefined
  const tool = event.toolName ?? event.toolInfo?.name ?? 'tool'
  const params = event.toolInfo?.parameters as Record<string, unknown> | undefined
  const subject = typeof params?.CommandLine === 'string' ? params.CommandLine
    : typeof params?.TargetFile === 'string' ? params.TargetFile
    : typeof params?.AbsolutePath === 'string' ? params.AbsolutePath : ''
  const detail = subject ? ' ' + sanitizeText(subject, { home: homeDirectory() }, 120).replace(/\s+/g, ' ') : ''
  const failed = state === 'ERROR' || (event.toolInfo?.error !== undefined && event.toolInfo.error !== null)
  const seconds = event.durationSeconds !== undefined ? ' (' + event.durationSeconds.toFixed(1) + 's)' : ''
  // Blank lines on both sides: a Markdown blockquote otherwise swallows the following text.
  return '\n\n> AGY · ' + tool + detail + (failed ? ' — failed' : ' — done') + seconds + '\n\n'
}

/** Compact one-line progress marker for the background job_output stream. */
function progressMarker(event: AgyStreamEvent): string {
  if (event.kind !== 'step') return ''
  const state = event.state ?? ''
  if (state !== 'DONE' && state !== 'ERROR') return ''
  if (event.stepType === 'tool' || event.toolInfo !== undefined) {
    const tool = event.toolName ?? 'tool'
    if (state === 'ERROR' || (event.toolInfo?.error !== undefined && event.toolInfo.error !== null)) {
      const message = sanitizeText(errorText(event.toolInfo?.error) ?? 'error', {}, 160).replace(/\s+/g, ' ')
      return `\n[agy: tool ${tool} error: ${message}]\n`
    }
    return `\n[agy: tool ${tool} done]\n`
  }
  const stepType = event.stepType ?? ''
  if (state === 'DONE' && stepType.length > 0 && stepType !== 'agent_response' && stepType !== 'user_input' && stepType !== 'unknown') {
    return `\n[agy: ${stepType} step done]\n`
  }
  return ''
}

/** Everything both the foreground and the background path need before spawning. */
interface SpawnPlan {
  childCwd: string
  env: Record<string, string>
  exe: string
  support: AgyFlagSupport
  /** Foreground JSON mode (conversation_id capture). */
  jsonMode: boolean
  /** Background stream-json mode (live text deltas + conversation_id). */
  streamMode: boolean
  baseArgv: string[]
  promptFilePath: string | undefined
  releasePromptFile: () => void
  id: SessionId
  label: string
  /** Per-run agy hook supervision, when enabled. */
  supervisor?: SupervisorHandle
  /** The --model / --effort actually sent (requested values; the CLI decides what runs). */
  selection: { model?: string; effort?: string; source: 'explicit' | 'plugin-default' | 'cli-default' }
  /** DSH skills exposed to this run through the skills.json bridge. */
  sharedSkills: string[]
}

/** Compiled supervisor hook text, read once from lib/. */
let hookSourceCache: string | undefined
function supervisorHookSource(): string {
  hookSourceCache ??= readFileSync(fileURLToPath(new URL('./supervisor-hook.js', import.meta.url)), 'utf8')
  return hookSourceCache
}

/** Collect and remove a run's supervisor files; never throws. */
function finishSupervision(plan: SpawnPlan): SupervisionReport | undefined {
  const supervisor = plan.supervisor
  if (supervisor === undefined) return undefined
  try {
    return supervisor.collect()
  } catch {
    return undefined
  } finally {
    supervisor.dispose()
  }
}

class AntigravitySubagentProvider implements SubagentProvider {
  readonly capabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false
  readonly name: string

  /** Ephemeral runId → agy conversation bridge for the tool layer. */
  private readonly runRecords = new Map<string, TaskRecord>()
  /** Per-conversation gates: follow-ups to one agy conversation run strictly one at a time. */
  private readonly followupGates = new Map<string, Promise<void>>()
  /** Cached result of the one-time `agy help` flag probe. */
  private flagSupport: AgyFlagSupport | undefined
  /** Per-provider run id sequence (module-level state would reset on HMR reloads). */
  private runSeq = 0
  /** Live in-flight runs (foreground + background), for the tasks/cancel tools. */
  private readonly activeRuns = new Map<string, ActiveRunInfo>()

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly configuredCwd: string | undefined,
    /** Durable execution traces; undefined when tracing is disabled. */
    readonly traces?: TraceStore,
  ) {
    this.name = config.providerName
  }

  /** Real "agy models" catalog (TTL-cached; failures are reported, not cached). */
  readonly models = new AgyModelCatalog(() => this.fetchAgyModelsOutput())

  /** Run `agy models` (no agent turn, no quota) through the subprocess seam. */
  private async fetchAgyModelsOutput(): Promise<string> {
    const env = { ...scrubbedParentEnv(), ...this.config.env }
    applyProxyEnv(env, resolveProxyUrl(this.config))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS)
    try {
      const exe = await this.resolveCommandPath(env, controller.signal)
      const handle = this.ctx.subprocess.spawn({
        argv: [exe, 'models'],
        cwd: tmpdir(),
        // stdin must not be an open pipe: agy waits for EOF on it.
        stdio: { stdin: 'ignore', stdout: { maxBytes: 256 << 10 }, stderr: { maxBytes: 64 << 10 } },
        graceMs: this.config.disposeGraceMs,
        signal: controller.signal,
        env,
      })
      const outcome = await handle.done
      const stdout = handle.collected?.stdout?.readFrom(0).text ?? ''
      const stderr = handle.collected?.stderr?.readFrom(0).text ?? ''
      if (controller.signal.aborted) throw new Error(`"agy models" timed out after ${MODELS_TIMEOUT_MS} ms`)
      if (outcome.exitCode !== 0) {
        throw new Error(`"agy models" exited with code ${String(outcome.exitCode)}: ${stderr.trim().split(/\r?\n/).pop() ?? ''}`)
      }
      return stdout
    } finally {
      clearTimeout(timer)
    }
  }

  /** Task keys of in-flight runs appending to `traceKey`. */
  activeRunsFor(traceKey: string): Set<string> {
    const out = new Set<string>()
    for (const [task, info] of this.activeRuns) if (info.traceKey === traceKey) out.add(task)
    return out
  }

  /** Link independently collected evidence to a trace run (no-op without tracing). */
  recordEvidence(traceKey: string, runId: string, evidence: TaskEvidence): void {
    if (this.traces === undefined) return
    try {
      recordEvidence(this.traces, traceKey, runId, evidence)
    } catch (error) {
      this.ctx.logger.warn(`${PREFIX}: failed to link evidence to trace: ${String(error)}`)
    }
  }

  /** Create (or reuse) the trace and a recorder for one run. */
  private createRecorder(
    traceKey: string,
    runId: string,
    cwd: string,
    parent: unknown,
    observe: AgyRunStreamOptions,
  ): RunTraceRecorder | undefined {
    const traces = this.traces
    if (traces === undefined) return undefined
    traces.ensure({
      trace_key: traceKey,
      kind: observe.traceKind ?? 'task',
      owner: observe.owner !== undefined ? observe.owner : agentIdOf(parent),
      child_id: observe.childId ?? null,
    })
    return new RunTraceRecorder(traces, traceKey, runId, { cwd, home: homeDirectory() })
  }

  /** The bridge record for one finished run (for persistence), if captured. */
  recordOf(runId: string): TaskRecord | undefined {
    return this.runRecords.get(runId)
  }

  /** Register one in-flight run; released automatically when `settled` resolves or rejects. */
  private trackActive(task: string, info: ActiveRunInfo, settled: Promise<unknown>): void {
    this.activeRuns.set(task, info)
    const release = (): void => {
      if (this.activeRuns.get(task) === info) this.activeRuns.delete(task)
    }
    void settled.then(release, release)
  }

  /** Snapshot of every in-flight run (foreground + background), newest first. */
  listActive(): { task: string; label: string; cwd: string; background: boolean; startedAt: number }[] {
    return [...this.activeRuns.entries()]
      .sort((a, b) => b[1].startedAt - a[1].startedAt)
      .map(([task, info]) => ({
        task,
        label: info.label,
        cwd: info.cwd,
        background: info.background,
        startedAt: info.startedAt,
      }))
  }

  /** Request cancellation of one in-flight run by its task key; false when it is not tracked. */
  cancelActive(task: string): boolean {
    const info = this.activeRuns.get(task)
    if (info === undefined) return false
    info.cancel()
    return true
  }

  /** Terminate every in-flight run (plugin stop/update): returns how many were cancelled. */
  terminateAllActive(): number {
    let count = 0
    for (const info of this.activeRuns.values()) {
      info.cancel()
      count += 1
    }
    return count
  }

  private nextRunId(): string {
    this.runSeq += 1
    return `${Date.now().toString(36)}-${this.runSeq.toString(36)}`
  }

  private remember(runId: string, conversationId: string | undefined, cwd: string, label: string, selection: { model?: string; effort?: string } = {}): void {
    if (conversationId === undefined || conversationId.length === 0) return
    this.runRecords.set(runId, {
      conversationId, cwd, label, createdAt: Date.now(),
      ...(selection.model ? { model: selection.model } : {}),
      ...(selection.effort ? { effort: selection.effort } : {}),
    })
    if (this.runRecords.size > MAX_RUN_RECORDS) {
      const oldest = [...this.runRecords.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
      if (oldest !== undefined) this.runRecords.delete(oldest[0])
    }
  }

  /**
   * Resolve the configured command through the subprocess seam (PATH lookup),
   * falling back to well-known install locations and the AGY_BIN override when
   * PATH misses it — the official Windows installer drops the binary into
   * `%LOCALAPPDATA%\agy\bin`, which is rarely on any process PATH.
   */
  private async resolveCommandPath(env: Record<string, string>, signal: AbortSignal): Promise<string> {
    const { ctx, config } = this
    let pathError: unknown
    try {
      return await ctx.subprocess.resolveExecutable(config.command, env, signal)
    } catch (error) {
      pathError = error
    }
    const exeName = process.platform === 'win32' ? 'agy.exe' : 'agy'
    const candidates: string[] = []
    if (process.env.AGY_BIN !== undefined && process.env.AGY_BIN.length > 0) candidates.push(process.env.AGY_BIN)
    if (process.env.LOCALAPPDATA !== undefined) candidates.push(join(process.env.LOCALAPPDATA, 'agy', 'bin', exeName))
    const home = process.env.USERPROFILE ?? process.env.HOME
    if (home !== undefined) {
      candidates.push(join(home, '.local', 'bin', exeName))
      candidates.push(join(home, '.gemini', 'bin', exeName))
      candidates.push(join(home, 'go', 'bin', exeName))
    }
    for (const candidate of candidates) {
      try {
        const resolved = await ctx.subprocess.resolveExecutable(candidate, env, signal)
        ctx.logger.warn(`${PREFIX}: "${config.command}" not found on PATH, using fallback ${resolved}`)
        return resolved
      } catch {
        // try the next candidate
      }
    }
    throw pathError instanceof Error ? pathError : new Error(`${PREFIX}: cannot resolve "${config.command}"`)
  }

  private async resolveExecutable(request: ResolvedSubagentStartRequest, env: Record<string, string>): Promise<string> {
    return this.resolveCommandPath(env, request.signal)
  }

  /**
   * Open agy's interactive login in a new console window (Windows) so the
   * user can authenticate on the spot; other platforms get instructions.
   * Fire-and-forget: the window is the user's to close.
   */
  async launchLogin(): Promise<string> {
    const { ctx, config } = this
    const env = { ...scrubbedParentEnv(), ...config.env }
    applyProxyEnv(env, resolveProxyUrl(config))
    const controller = new AbortController()
    const exe = await this.resolveCommandPath(env, controller.signal)
    if (process.platform === 'win32') {
      try {
        // PowerShell Start-Process opens the console app in its own window.
        // Single-quoted path avoids the cmd `start` title/command quoting
        // hell (which previously mangled the command into a bogus "loginy").
        const psPath = exe.replace(/'/g, "''")
        const style = config.loginWindowMinimized ? ' -WindowStyle Minimized' : ''
        ctx.subprocess.spawn({
          argv: ['powershell.exe', '-NoProfile', '-Command', `Start-Process -FilePath '${psPath}'${style}`],
          cwd: process.cwd(),
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 4 << 10 },
            stderr: { maxBytes: 4 << 10 },
          },
          graceMs: config.disposeGraceMs,
        })
        lastLoginLaunchAt = Date.now()
        return `Opened the interactive Antigravity login window (${exe}). Complete the sign-in in the new window (a browser may open for Google sign-in), close it, then retry the antigravity tool.`
      } catch (error) {
        return `Could not open a login window automatically (${error instanceof Error ? error.message : String(error)}). Please open a terminal, run \`agy\` and complete the sign-in, then retry.`
      }
    }
    return 'On this platform the plugin cannot open an interactive terminal automatically. Please open a terminal, run `agy` and complete the sign-in, then retry.'
  }

  /**
   * Enrich an auth-error detail: append the manual hint, and when
   * `autoLoginWindow` is on, pop the interactive login window once (with a
   * cooldown) and say so.
   */
  private maybeAutoLogin(detail: string): string {
    const hinted = authHintFor(detail)
    if (!isAuthError(detail) || !this.config.autoLoginWindow) return hinted
    const now = Date.now()
    if (now - lastLoginLaunchAt < LOGIN_LAUNCH_COOLDOWN_MS) return hinted
    lastLoginLaunchAt = now
    void this.launchLogin().then(
      (message) => this.ctx.logger.info(`${PREFIX}: ${message}`),
      (error) => this.ctx.logger.warn(`${PREFIX}: could not open login window: ${String(error)}`),
    )
    return `${hinted}\n(A login window has been opened on the machine — complete the sign-in there, then retry.)`
  }

  /**
   * Probe which flags the installed agy build understands. Runs once per
   * provider instance (cached), cheap (~100 ms), and never requires a login.
   * `agy --help` itself is an unknown flag on some builds, so the probe uses
   * `help` and accepts the usage dump regardless of the exit code.
   */
  private async probeFlags(exe: string, env: Record<string, string>, cwd: string): Promise<AgyFlagSupport> {
    if (this.flagSupport !== undefined) return this.flagSupport
    let support = UNKNOWN_FLAG_SUPPORT
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    try {
      const handle = this.ctx.subprocess.spawn({
        argv: [exe, 'help'],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 64 << 10 },
          stderr: { maxBytes: 64 << 10 },
        },
        graceMs: this.config.disposeGraceMs,
        signal: controller.signal,
        env,
      })
      await handle.done
      const text =
        (handle.collected?.stdout?.readFrom(0).text ?? '') + (handle.collected?.stderr?.readFrom(0).text ?? '')
      support = parseFlagSupport(text)
    } catch (error) {
      this.ctx.logger.warn(
        `${PREFIX}: flag probe failed (${error instanceof Error ? error.message : String(error)}); assuming standard flags`,
      )
    } finally {
      clearTimeout(timer)
    }
    this.flagSupport = support
    this.ctx.logger.info(`${PREFIX}: agy flag support: ${JSON.stringify(support)}`)
    return support
  }

  /**
   * Shared pre-spawn planning for both the foreground and the background
   * path: env/cwd/exe resolution, the flag probe, prompt validation and the
   * argv-safe prompt-file path, and the full base argv (minus the wire
   * format and conversation flags, which each caller appends).
   */
  // Per-delegation overrides do not mutate the shared plugin configuration.
  private async spawnPlan(
    request: ResolvedSubagentStartRequest,
    conversationId: string | undefined,
    cwdOverride: string | undefined,
    dirs: readonly string[],
    timeoutMs: number,
    options: { cwd?: string; model?: string; effort?: string } = {},
  ): Promise<SpawnPlan> {
    const { ctx, config } = this
    const addDirs = validateAddDirs(PREFIX, dirs, 'config/tool')
    const childCwd = cwdOverride ?? resolveChildCwd(PREFIX, options.cwd ? validateConfiguredCwd(PREFIX, options.cwd) : this.configuredCwd, request.parent.session.header.cwd)
    const env = { ...scrubbedParentEnv(), ...config.env }
    applyProxyEnv(env, resolveProxyUrl(config))
    const exe = await this.resolveExecutable(request, env)
    const promptText = textOfPrompt(request.prompt)
    if (promptText.trim().length === 0) throw new Error(`${PREFIX}: request prompt contains no text`)
    let effectivePrompt = promptText
    if (config.avoidBrowser) effectivePrompt += AVOID_BROWSER_SUFFIX
    if (config.avoidLargeReads) effectivePrompt += AVOID_LARGE_READ_SUFFIX

    const support = await this.probeFlags(exe, env, childCwd)
    const id = `${request.parent.session.id}::agy::${this.nextRunId()}` as unknown as SessionId
    const supervisionBase = config.supervisionDir.length > 0 ? config.supervisionDir : join(pluginBaseDir() || join(homeDirectory(), '.dsh'), 'agy-supervisor')
    let supervisorDir: string | undefined
    if (config.supervisionEnabled) {
      // Fail closed: an explicitly enabled guardrail is never silently skipped.
      if (!config.skipPermissions) {
        throw new Error(`${PREFIX}: supervisionEnabled is on but cannot be applied: it requires skipPermissions (hook "allow" would otherwise change headless approval behavior)`)
      }
      if (support.probed && !support.addDir) {
        throw new Error(`${PREFIX}: supervisionEnabled is on but cannot be applied: this agy build lacks --add-dir, which carries the per-run hooks`)
      }
      supervisorDir = supervisorDirFor(supervisionBase, id as unknown as string)
      effectivePrompt += supervisionPromptNote(childCwd, supervisorDir)
    }
    if (conversationId !== undefined && !support.conversation) {
      throw new Error(
        `${PREFIX}: this agy build does not support --conversation — cannot resume task "${conversationId}". Upgrade agy or start a new task.`,
      )
    }
    const jsonMode = config.outputFormat === 'json' && (support.outputFormat || !support.probed)
    if (config.outputFormat === 'json' && support.probed && !support.outputFormat) {
      ctx.logger.warn(
        `${PREFIX}: this agy build lacks --output-format; running in text mode (no conversation_id, follow-ups will not record)`,
      )
    }
    if (config.sandbox && support.probed && !support.sandbox) {
      ctx.logger.warn(`${PREFIX}: this agy build lacks --sandbox; skipping the flag`)
    }
    if (addDirs.length > 0 && support.probed && !support.addDir) {
      throw new Error(
        `${PREFIX}: this agy build does not support --add-dir — cannot add ${addDirs.join(', ')}. Upgrade agy, or move the target inside the session workspace.`,
      )
    }

    // argv safety: never pass a giant prompt as one argument. agy has no
    // --prompt-file today; if a future build adds it, the probe enables it
    // automatically and the prompt is handed over via a temp file instead.
    let promptFilePath: string | undefined
    let promptArgv: string[]
    if (effectivePrompt.length > MAX_ARGV_PROMPT_CHARS) {
      if (!support.promptFile) {
        throw new Error(
          `${PREFIX}: prompt is ${effectivePrompt.length} chars, exceeding the ${MAX_ARGV_PROMPT_CHARS}-char argv limit, and this agy build does not support --prompt-file. Split the task into smaller steps, or write the bulky context into files in the workspace and reference them from a short prompt.`,
        )
      }
      promptFilePath = join(tmpdir(), `${PREFIX}-${this.nextRunId()}-prompt.txt`)
      try {
        writeFileSync(promptFilePath, effectivePrompt, 'utf8')
      } catch (error) {
        rmSync(promptFilePath, { force: true })
        throw error
      }
      promptArgv = ['--prompt-file', promptFilePath]
    } else {
      promptArgv = ['-p', effectivePrompt]
    }

    const baseArgv: string[] = [
      exe,
      ...promptArgv,
      '--print-timeout',
      `${Math.max(1, Math.round(timeoutMs / 1000))}s`,
    ]
    let effectiveModel = (options.model ?? config.model).trim()
    let effectiveEffort = (options.effort ?? config.effort).trim().toLowerCase()
    if (effectiveModel.length > 0) {
      // Map base ids / variant ids onto what agy accepts (--model base --effort e,
      // or a variant-less id without --effort). A listing failure leaves the raw
      // values to agy, which rejects unknown models within seconds.
      let models: AgyBaseModel[] | undefined
      try {
        models = await this.models.list()
      } catch (error) {
        ctx.logger.warn(`${PREFIX}: cannot validate AGY model ${effectiveModel} (${error instanceof Error ? error.message : String(error)}); passing it to agy unvalidated`)
      }
      if (models !== undefined) {
        try {
          const resolved = resolveSelection(models, effectiveModel, effectiveEffort || undefined)
          effectiveModel = resolved.args.model ?? effectiveModel
          effectiveEffort = resolved.args.effort ?? ''
        } catch (error) {
          if (error instanceof AgyModelSelectionError) throw new Error(`${PREFIX}: ${error.message}`)
          throw error
        }
      }
    }
    const selection: SpawnPlan['selection'] = {
      ...(effectiveModel.length > 0 ? { model: effectiveModel } : {}),
      ...(effectiveEffort.length > 0 ? { effort: effectiveEffort } : {}),
      source: options.model !== undefined || options.effort !== undefined ? 'explicit'
        : config.model.length > 0 || config.effort.length > 0 ? 'plugin-default' : 'cli-default',
    }
    if (effectiveModel.length > 0) baseArgv.push('--model', effectiveModel)
    if (effectiveEffort.length > 0) {
      if (!(EFFORT_ORDER as readonly string[]).includes(effectiveEffort)) {
        throw new Error(`${PREFIX}: effort must be one of low | medium | high | xhigh | max`)
      }
      baseArgv.push('--effort', effectiveEffort)
    }
    // DSH skills shared with AGY (declared via skills.json in a bridge directory).
    const shared = await this.sharedSkillBridge(childCwd)
    if (shared !== undefined) {
      if (support.probed && !support.addDir) {
        ctx.logger.warn(`${PREFIX}: this agy build lacks --add-dir; DSH skills are not shared`)
      } else {
        baseArgv.push('--add-dir', shared.dir)
      }
    }
    if (config.agent.length > 0) baseArgv.push('--agent', config.agent)
    if (config.skipPermissions) baseArgv.push('--dangerously-skip-permissions')
    if (config.sandbox && support.sandbox) baseArgv.push('--sandbox')
    for (const dir of addDirs) baseArgv.push('--add-dir', dir)
    baseArgv.push(...config.extraArgs)

    const releasePromptFile = (): void => {
      if (promptFilePath !== undefined) {
        try {
          rmSync(promptFilePath, { force: true })
        } catch {
          // best-effort temp cleanup
        }
      }
    }

    let supervisor: SupervisorHandle | undefined
    if (supervisorDir !== undefined) {
      const refuse = (reason: string): never => {
        releasePromptFile()
        throw new Error(`${PREFIX}: supervisionEnabled is on but cannot be applied: ${reason}`)
      }
      try {
        supervisor = prepareSupervisor({
          baseDir: supervisionBase,
          dir: supervisorDir,
          runId: id as unknown as string,
          roots: [childCwd, ...addDirs],
          ...(shared !== undefined ? { readRoots: shared.roots } : {}),
          cwd: childCwd,
          home: homeDirectory(),
          settings: {
            denyCommands: config.supervisionDenyCommands,
            builtinRules: config.supervisionBuiltinRules,
            stopCheck: config.supervisionStopCheck,
            stopCheckTimeoutMs: config.supervisionStopCheckTimeoutMs,
            maxReworks: config.supervisionMaxReworks,
          },
          hookSource: supervisorHookSource(),
          execPath: process.execPath,
        })
      } catch (error) {
        refuse(error instanceof Error ? error.message : String(error))
      }
      baseArgv.push('--add-dir', supervisor!.dir)
      Object.assign(env, supervisor!.env)
    }

    return {
      childCwd,
      env,
      exe,
      support,
      jsonMode,
      streamMode: jsonMode && (support.streamJson || !support.probed),
      baseArgv,
      promptFilePath,
      releasePromptFile,
      id,
      label: request.label ?? 'antigravity task',
      ...(supervisor !== undefined ? { supervisor } : {}),
      selection,
      sharedSkills: shared?.names ?? [],
    }
  }

  /**
   * Bridge directory exposing the configured DSH skills to agy: its
   * .agents/skills.json declares each skill's parent folder with include_only
   * (verified on agy 1.4.0 for --add-dir directories and absolute Windows
   * paths). Content-addressed and reused; nothing is copied or linked.
   */
  private async sharedSkillBridge(cwd: string): Promise<{ dir: string; names: string[]; roots: string[] } | undefined> {
    const patterns = this.config.sharedSkills.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0)
    if (patterns.length === 0) return undefined
    const registry = (this.ctx as unknown as { get(name: string): unknown }).get('skills') as
      | { list(options?: { cwd?: string }): Promise<{ name: string; path?: string; invocation?: { modelInvocable?: boolean } }[]> }
      | undefined
    if (registry === undefined || typeof registry.list !== 'function') {
      this.ctx.logger.warn(`${PREFIX}: sharedSkills is set but the DSH skill registry is unavailable`)
      return undefined
    }
    let skills: { name: string; path?: string; invocation?: { modelInvocable?: boolean } }[]
    try {
      skills = await registry.list({ cwd })
    } catch (error) {
      this.ctx.logger.warn(`${PREFIX}: cannot list DSH skills for AGY: ${String(error)}`)
      return undefined
    }
    const wanted = (name: string): boolean => patterns.some((pattern) =>
      pattern === '*' || (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern))
    const chosen = skills.filter((skill) => skill.invocation?.modelInvocable !== false && typeof skill.path === 'string' &&
      isAbsolute(skill.path) && /[\\/]SKILL\.md$/i.test(skill.path) && wanted(skill.name))
    if (chosen.length === 0) {
      this.ctx.logger.warn(`${PREFIX}: sharedSkills matched no file-backed DSH skill (${patterns.join(', ')})`)
      return undefined
    }
    const groups = new Map<string, Set<string>>()
    for (const skill of chosen) {
      const folder = dirname(skill.path as string)
      const parent = dirname(folder).replace(/\\/g, '/')
      const names = groups.get(parent) ?? new Set<string>()
      names.add(basename(folder))
      groups.set(parent, names)
    }
    const manifest = JSON.stringify({
      entries: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([path, names]) => ({ path, include_only: [...names].sort() })),
    }, null, 2)
    const root = this.config.sharedSkillsDir.length > 0 ? this.config.sharedSkillsDir : join(pluginBaseDir() || join(homeDirectory(), '.dsh'), 'agy-skill-bridge')
    pruneOldDirectories(root, 7 * 24 * 60 * 60 * 1000)
    const dir = join(root, createHash('sha256').update(manifest).digest('hex').slice(0, 16))
    const file = join(dir, '.agents', 'skills.json')
    mkdirSync(dirname(file), { recursive: true })
    if (!existsSync(file) || readFileSync(file, 'utf8') !== manifest) writeFileSync(file, manifest, 'utf8')
    const now = new Date()
    utimesSync(dir, now, now)
    return { dir, names: chosen.map((skill) => skill.name).sort(), roots: chosen.map((skill) => dirname(skill.path as string)) }
  }

  /** Opt-in DSH 0.2 native continuable creation. DSH owns the actual Agent and Session. */
  async prepareContinuable(request?: { sessionId?: unknown; parent?: unknown }): Promise<{}> {
    if (!this.config.nativeContinuableEnabled) {
      throw new Error(`${PREFIX}: native continuable disabled in plugin config`)
    }
    // The manager has reserved the durable child id and knows the delegating
    // parent: record trace ownership before the child's first turn can run.
    const childId = typeof request?.sessionId === 'string' ? request.sessionId : undefined
    if (childId !== undefined && this.traces !== undefined) {
      this.traces.ensure({ trace_key: childId, kind: 'native', owner: agentIdOf(request?.parent), child_id: childId })
    }
    return {}
  }

  /** DSH SubagentRuntime.start invokes this for both foreground and background.
   *  Passing all task variants through the manager emits the real lifecycle pair.
   *  A remote run has localAgent=undefined, so no fake DSH child session is claimed.
   */
  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const agy = (request as ResolvedSubagentStartRequest & { agyOptions?: AgyNativeOptions }).agyOptions ?? {}
    if (agy.background) {
      const bg = await this.startBackground(request, agy.dirs ?? [], agy)
      const output = backgroundOutputSource(bg.readOutput)
      const run: AgyManagedBackgroundRun = {
        id: bg.id,
        localAgent: undefined,
        result: bg.done.then((outcome) => ({
          output: textBlocks(output.read(0).text),
          stopReason: outcome.status === 'completed' ? 'completed' as const :
            outcome.status === 'killed' ? 'aborted' as const : 'error' as const,
          ...(outcome.status === 'completed' ? {} : { diagnostic: outcome.detail.slice(0, 4096) }),
        })),
        dispose: async () => {
          bg.cancel()
          await bg.done
        },
        agyBackground: { cancel: bg.cancel, done: bg.done, output },
      }
      return run
    }
    const dirs = [...this.config.addDirs, ...(agy.dirs ?? [])]
    if (agy.conversationId !== undefined) {
      const conversationId = agy.conversationId
      const stream: AgyRunStreamOptions = { mode: 'followup', ...(agy.traceKey !== undefined ? { traceKey: agy.traceKey } : {}) }
      return this.followupSerialized(conversationId,
        () => this.runOnce(request, conversationId, agy.cwd, dirs, this.config.printTimeoutMs, { ...agy, stream }))
    }
    return this.runOnce(request, undefined, undefined, dirs, this.config.printTimeoutMs, { ...agy, stream: { mode: 'foreground' } })
  }


  /** Tool-layer entry: new task plus extra workspace dirs (config.addDirs ∪ tool dirs). */
  startWithDirs(request: SubagentStartRequest, extraDirs: readonly string[], options: AgyRunOptions = {}): Promise<SubagentRun> {
    return this.runOnce(request as ResolvedSubagentStartRequest, undefined, undefined, [...this.config.addDirs, ...extraDirs], options.timeoutMs ?? this.config.printTimeoutMs, options)
  }

  /**
   * Follow-up entry: resume an existing agy conversation in its recorded
   * cwd. Same-conversation follow-ups are serialized per conversation id, so
   * concurrent prompts cannot corrupt one agy conversation file.
   */
  followup(request: FollowupRequest, conversationId: string, cwd: string, options: Omit<AgyRunOptions, 'cwd'> = {}): Promise<SubagentRun> {
    return this.followupSerialized(conversationId, () => this.runOnce(request as ResolvedSubagentStartRequest, conversationId, cwd, [...this.config.addDirs, ...(options.dirs ?? [])], options.timeoutMs ?? this.config.printTimeoutMs, options))
  }

  private followupSerialized(conversationId: string, task: () => Promise<SubagentRun>): Promise<SubagentRun> {
    const prev = this.followupGates.get(conversationId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    this.followupGates.set(conversationId, gate)
    const settleGate = (): void => {
      release()
      // Drop the gate only when nobody chained onto it after us.
      if (this.followupGates.get(conversationId) === gate) this.followupGates.delete(conversationId)
    }
    return prev.then(task).then(
      async (run) => {
        try {
          // Hold the gate until the run's result settles, not just until the handle exists.
          await run.result
        } finally {
          settleGate()
        }
        return run
      },
      (error: unknown) => {
        settleGate()
        throw error
      },
    )
  }

  private async runOnce(
    request: ResolvedSubagentStartRequest,
    conversationId: string | undefined,
    cwdOverride: string | undefined,
    dirs: readonly string[],
    timeoutMs: number,
    options: AgyRunOptions = {},
  ): Promise<SubagentRun> {
    const { ctx, config } = this
    const plan = await this.spawnPlan(request, conversationId, cwdOverride, dirs, timeoutMs, options)
    const observe = options.stream ?? {}
    // stream-json whenever the build supports it and somebody consumes events
    // (durable trace and/or native live text); otherwise the historic json mode.
    const streaming = plan.streamMode && (this.traces !== undefined || observe.onText !== undefined)
    const traceKey = observe.traceKey ?? (plan.id as unknown as string)
    const recorder = this.createRecorder(traceKey, plan.id as unknown as string, plan.childCwd, request.parent, observe)

    // Local cancellation state: dispose() may settle teardown without the
    // request signal firing, so a killed agy must still land on 'aborted'.
    let cancelled = false
    // Watchdog: agy's own --print-timeout can be ignored when it hangs
    // (network stall, auth wait); a local timer terminates the tree.
    let timedOut = false
    let watchdog: NodeJS.Timeout | undefined
    let current: { handle: SubprocessHandle; stream?: LiveStream } | undefined
    let lastOutcome: { exitCode: number | null; signal: string | null } | undefined
    let lastStderr = ''
    const ensureTerminated = (): void => {
      current?.handle.terminate()
    }
    const onAbort = (): void => {
      cancelled = true
      ensureTerminated()
    }
    const armWatchdog = (): void => {
      clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        timedOut = true
        ctx.logger.warn(
          `${PREFIX}: agy run exceeded ${timeoutMs + config.watchdogMarginMs}ms watchdog (ceiling ${timeoutMs}ms + margin ${config.watchdogMarginMs}ms), terminating the process tree`,
        )
        ensureTerminated()
      }, timeoutMs + config.watchdogMarginMs)
    }
    const disarmWatchdog = (): void => {
      clearTimeout(watchdog)
    }
    const onEvent = (event: AgyStreamEvent): void => {
      recorder?.onEvent(event)
      try {
        observe.onEvent?.(event)
      } catch (error) {
        ctx.logger.warn(`${PREFIX}: stream event consumer failed: ${String(error)}`)
      }
      if (event.kind === 'step' && event.textDelta !== undefined && event.textDelta.length > 0) {
        try {
          observe.onText?.(event.textDelta)
        } catch (error) {
          ctx.logger.warn(`${PREFIX}: live text consumer failed: ${String(error)}`)
        }
      }
    }

    const spawnOnce = (format: TraceTransport): { handle: SubprocessHandle; stream?: LiveStream } => {
      const argv = [...plan.baseArgv]
      if (format !== 'text') argv.push('--output-format', format)
      if (conversationId !== undefined) argv.push('--conversation', conversationId)
      const live = format === 'stream-json'
      const handle = ctx.subprocess.spawn({
        argv,
        cwd: plan.childCwd,
        stdio: {
          stdin: 'ignore',
          stdout: live ? 'pipe' : { maxBytes: MAX_STDOUT_BYTES, spill: { maxBytes: MAX_STDOUT_SPILL_BYTES } },
          stderr: { maxBytes: MAX_STDERR_BYTES },
        },
        graceMs: config.disposeGraceMs,
        signal: request.signal,
        env: plan.env,
      })
      current = live ? { handle, stream: attachStream(handle.stdout, onEvent) } : { handle }
      return current
    }

    const readStdout = (handle: { collected?: import('@deepseek-ai/dsh-subprocess').SubprocessCollectedOutputs }): string =>
      handle.collected?.stdout?.readFrom(0).text ?? ''
    const readStderr = (handle: { collected?: import('@deepseek-ai/dsh-subprocess').SubprocessCollectedOutputs }): string =>
      handle.collected?.stderr?.readFrom(0).text ?? ''

    const snapshot = (): { type: 'text'; text: string }[] => {
      const live = current
      if (live === undefined) return []
      const stdout = live.stream !== undefined ? live.stream.acc.fallbackText() : readStdout(live.handle)
      const stderr = readStderr(live.handle)
      return textBlocks(stderr.length > 0 ? `${stdout}\n${stderr}` : stdout)
    }

    const attempt = async (): Promise<SubagentResult> => {
      try {
        // A cancellation that arrived before the spawn must not spawn at all.
        if (cancelled || request.signal.aborted) return { output: [], stopReason: 'aborted' }
        let format: TraceTransport = streaming ? 'stream-json' : plan.jsonMode ? 'json' : 'text'
        recorder?.start({
          mode: observe.mode ?? (conversationId !== undefined ? 'followup' : 'foreground'),
          label: plan.label,
          resumed: conversationId !== undefined,
          ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
          transport: format,
          supervision: plan.supervisor !== undefined ? 'enforced' : 'off',
          model: plan.selection.model ?? null,
          effort: plan.selection.effort ?? null,
          model_source: plan.selection.source,
          ...(plan.sharedSkills.length > 0 ? { shared_skills: plan.sharedSkills } : {}),
        })
        let run = spawnOnce(format)
        armWatchdog()
        let outcome = await run.handle.done
        if (run.stream !== undefined) await settleWithin(run.stream.drained, config.disposeGraceMs)
        let stderr = readStderr(run.handle)
        // Only when the probe failed and we assumed --output-format support:
        // a build that actually rejects the flag gets one retry in text mode.
        if (
          !cancelled &&
          !request.signal.aborted &&
          format !== 'text' &&
          !plan.support.probed &&
          outcome.exitCode !== 0 &&
          isUnknownFlagError(stderr)
        ) {
          run.handle.terminate()
          format = 'text'
          recorder?.transport('text', 'agy rejected --output-format; retried once in text mode (final-only, no step records)')
          run = spawnOnce('text')
          armWatchdog()
          outcome = await run.handle.done
          stderr = readStderr(run.handle)
        }
        lastOutcome = { exitCode: outcome.exitCode, signal: outcome.signal ?? null }
        lastStderr = stderr
        const stdout = run.stream !== undefined ? run.stream.acc.fallbackText() : readStdout(run.handle)
        if (cancelled || request.signal.aborted) return { output: textBlocks(stdout), stopReason: 'aborted' }
        if (timedOut) {
          return {
            output: textBlocks(
              authHintFor(
                `agy did not finish within ${timeoutMs + config.watchdogMarginMs}ms (ceiling ${timeoutMs}ms + watchdog margin); the process tree was terminated.${
                  stderr.trim().length > 0 ? `\n${stderr.trim()}` : ''
                }`,
              ),
            ),
            stopReason: 'error',
          }
        }

        const parsed = run.stream !== undefined ? run.stream.acc.reply() : tryParseJsonOutput(stdout)
        if (parsed !== undefined) {
          const conversation = parsed.conversation_id
          if (parsed.status === 'SUCCESS' && typeof parsed.response === 'string') {
            this.remember(plan.id, conversation, plan.childCwd, plan.label, plan.selection)
            return { output: textBlocks(parsed.response), stopReason: 'completed' }
          }
          const detail = this.maybeAutoLogin(
            typeof parsed.error === 'string' && parsed.error.length > 0
              ? parsed.error
              : stderr.trim() || `agy exited with code ${String(outcome.exitCode)}`,
          )
          this.remember(plan.id, conversation, plan.childCwd, plan.label, plan.selection)
          return { output: textBlocks(detail), stopReason: 'error' }
        }
        // A stream that never reached its terminal result still identified the conversation.
        if (run.stream !== undefined) this.remember(plan.id, run.stream.acc.conversationId, plan.childCwd, plan.label, plan.selection)

        // Plain-text path (text mode, non-JSON stdout, or a stream without a terminal result).
        if (outcome.exitCode === 0) {
          if (stdout.trim().length === 0) {
            return {
              output: textBlocks(
                `agy exited 0 but produced no stdout (stderr: ${stderr.trim() || '(empty)'}) — known Antigravity CLI behavior: \`agy -p\` can drop output under a non-TTY pipe on some builds. Verify with an interactive \`agy\` run once, then retry, or upgrade agy.`,
              ),
              stopReason: 'error',
            }
          }
          return { output: textBlocks(stdout), stopReason: 'completed' }
        }
        const detail = this.maybeAutoLogin(stderr.trim().length > 0 ? stderr.trim() : `agy exited with code ${String(outcome.exitCode)}`)
        return { output: textBlocks(detail), stopReason: 'error' }
      } finally {
        disarmWatchdog()
        plan.releasePromptFile()
      }
    }

    const result = settleRunResult({
      attempt,
      collectOutput: snapshot,
      cancelled: () => cancelled || request.signal.aborted,
      signal: request.signal,
      onAbort,
      onError: (error, stopReason) => ctx.logger.warn(`${PREFIX}: agy run failed (${stopReason}): ${error.message}`),
    })
    // Supervisor files are collected and removed once the run settles; run_end
    // lands before any caller links evidence (reaction order).
    void result.then((settled) => {
      const supervision = finishSupervision(plan)
      if (recorder !== undefined) {
        if (supervision !== undefined) recorder.supervision(supervision)
        const wasCancelled = cancelled || request.signal.aborted
        recorder.end({
          outcome: timedOut ? 'timeout' : wasCancelled || settled.stopReason === 'aborted' ? 'cancelled'
            : settled.stopReason === 'completed' ? 'completed' : 'failed',
          exit_code: lastOutcome?.exitCode ?? null,
          signal: lastOutcome?.signal ?? null,
          timed_out: timedOut,
          cancelled: wasCancelled,
          stderr: lastStderr,
          agy_error: parseAgyErrorLine(lastStderr),
          ...(settled.stopReason === 'completed' ? {} : {
            diagnostic: settled.output.map((block) => (block.type === 'text' ? block.text : '')).join('').slice(0, 1000),
          }),
          ...(supervision !== undefined ? { supervision } : {}),
        })
      }
    })
    // Track for the tasks/cancel tools; released when the result settles.
    this.trackActive(
      plan.id,
      {
        label: plan.label,
        cwd: plan.childCwd,
        startedAt: Date.now(),
        background: false,
        cancel: () => {
          cancelled = true
          ensureTerminated()
        },
        ...(recorder !== undefined ? { traceKey } : {}),
      },
      result,
    )
    return subprocessRunHandle({
      id: plan.id,
      result,
      signal: request.signal,
      onAbort,
      requestCancel: () => {
        cancelled = true
        ensureTerminated()
      },
      teardown: async () => {
        ensureTerminated()
        let settle: (() => void) | undefined
        const guard = new Promise<void>((resolve) => {
          settle = resolve
        })
        const timer = setTimeout(() => settle?.(), config.disposeGraceMs)
        try {
          await Promise.race([current?.handle.waitForExit() ?? Promise.resolve(true), guard])
        } finally {
          clearTimeout(timer)
        }
      },
    })
  }

  /**
   * Background run for `ctx.jobs` registration: spawns agy immediately with
   * `--output-format stream-json` (falling back to json, then text), streams
   * the incremental `text_delta` chunks through `readOutput`, captures the
   * `conversation_id` from the init event, and persists the task record when
   * done. The final read carries a `[task: ...]` line for follow-ups.
   */
  async startBackground(request: SubagentStartRequest, extraDirs: readonly string[], options: AgyRunOptions = {}): Promise<AntigravityBackgroundHandle> {
    const { ctx, config } = this
    const plan = await this.spawnPlan(request as ResolvedSubagentStartRequest, undefined, undefined, [...config.addDirs, ...extraDirs], config.backgroundTimeoutMs, options)
    const id = plan.id
    const label = plan.label
    const ceiling = config.backgroundTimeoutMs
    const baseline = captureWorkspace(plan.childCwd)
    const observe = options.stream ?? {}
    const traceKey = observe.traceKey ?? (id as unknown as string)
    const recorder = this.createRecorder(traceKey, id as unknown as string, plan.childCwd, request.parent, observe)
    const format: TraceTransport = plan.streamMode ? 'stream-json' : plan.jsonMode ? 'json' : 'text'

    let timedOut = false
    let visible = ''
    let readOffset = 0
    let taskLine = ''
    let taskLineEmitted = false
    let handle: SubprocessHandle | undefined
    let live: LiveStream | undefined
    let watchdog: NodeJS.Timeout | undefined
    let cancelledByRequest = false
    const controller = new AbortController()

    /** Append to the live-output window, dropping the oldest bytes past MAX_VISIBLE_BYTES. */
    const appendVisible = (chunk: string): void => {
      if (chunk.length === 0) return
      visible += chunk
      if (visible.length > MAX_VISIBLE_BYTES) {
        const drop = visible.length - MAX_VISIBLE_BYTES
        visible = visible.slice(drop)
        readOffset = Math.max(0, readOffset - drop)
      }
    }

    const terminate = (): void => {
      handle?.terminate()
    }
    const armWatchdog = (): void => {
      clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        timedOut = true
        ctx.logger.warn(
          `${PREFIX}: background agy run exceeded ${ceiling + config.watchdogMarginMs}ms watchdog (ceiling ${ceiling}ms + margin ${config.watchdogMarginMs}ms), terminating the process tree`,
        )
        terminate()
      }, ceiling + config.watchdogMarginMs)
    }
    const disarmWatchdog = (): void => {
      clearTimeout(watchdog)
    }

    /** One decoded stream-json event (or bare json reply in fallback mode): live text, progress marker, trace. */
    const onEvent = (event: AgyStreamEvent): void => {
      recorder?.onEvent(event)
      if (event.kind !== 'step') return
      if (event.textDelta !== undefined && event.textDelta.length > 0) appendVisible(event.textDelta)
      // Compact progress marker for tool and other non-text steps, so a
      // job_output poll shows what agy is doing.
      appendVisible(progressMarker(event))
    }

    const spawnOnce = (): void => {
      const argv = [...plan.baseArgv]
      if (format !== 'text') argv.push('--output-format', format)
      handle = ctx.subprocess.spawn({
        argv,
        cwd: plan.childCwd,
        stdio: {
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: { maxBytes: MAX_STDERR_BYTES },
        },
        graceMs: config.disposeGraceMs,
        signal: controller.signal,
        env: plan.env,
      })
      armWatchdog()
      // UTF-8-safe line splitting: a multi-byte character split across stdout
      // chunks is decoded intact instead of turning into replacement chars.
      live = attachStream(handle.stdout, onEvent)
    }

    const done = (async (): Promise<{ status: 'killed' | 'completed' | 'failed'; detail: string }> => {
      let status: 'killed' | 'completed' | 'failed'
      let detail: string
      let evidenceStatus: ExecutionStatus = 'failed'
      let exitCode: number | null = null
      let exitSignal: string | null = null
      let stderr = ''
      recorder?.start({
        mode: observe.mode ?? 'background', label, resumed: false, transport: format,
        supervision: plan.supervisor !== undefined ? 'enforced' : 'off',
        model: plan.selection.model ?? null, effort: plan.selection.effort ?? null, model_source: plan.selection.source,
      })
      try {
        spawnOnce()
        const outcome = await handle!.done
        if (live !== undefined) await settleWithin(live.drained, config.disposeGraceMs)
        exitCode = outcome.exitCode
        exitSignal = outcome.signal ?? null
        stderr = handle!.collected?.stderr?.readFrom(0).text ?? ''
        const classified = classifyBackgroundTermination({
          timedOut, cancelledByRequest, signal: outcome.signal ?? null,
          finalStatus: live?.acc.status, exitCode: outcome.exitCode,
        })
        status = classified.jobStatus
        evidenceStatus = classified.evidenceStatus
        const finalError = live?.acc.error
        if (evidenceStatus === 'timeout') {
          detail = `agy did not finish within ${ceiling + config.watchdogMarginMs}ms (ceiling ${ceiling}ms + watchdog margin); the process tree was terminated`
        } else if (cancelledByRequest) {
          detail = 'cancelled by request'
        } else if (outcome.signal !== null) {
          detail = `signal: ${outcome.signal}`
        } else if (status === 'completed') {
          detail = 'completed'
        } else {
          detail = this.maybeAutoLogin(
            (finalError !== undefined && finalError.length > 0 ? finalError : stderr.trim()) || `agy exited with code ${String(outcome.exitCode)}`,
          )
        }
      } catch (error) {
        // Ensure rejected spawns and cancellations settle; the Jobs contract must not reject.
        evidenceStatus = timedOut ? 'timeout' : cancelledByRequest ? 'cancelled' : 'failed'
        status = evidenceStatus === 'failed' ? 'failed' : 'killed'
        detail = `agy background run failed: ${error instanceof Error ? error.message : String(error)}`
      } finally {
        disarmWatchdog()
        plan.releasePromptFile()
      }
      const conversationId = live?.acc.conversationId
      const supervision = finishSupervision(plan)
      if (supervision !== undefined) recorder?.supervision(supervision)
      recorder?.end({
        ...(supervision !== undefined ? { supervision } : {}),
        outcome: evidenceStatus,
        exit_code: exitCode,
        signal: exitSignal,
        timed_out: timedOut,
        cancelled: cancelledByRequest,
        stderr,
        agy_error: parseAgyErrorLine(stderr),
        ...(evidenceStatus === 'completed' ? {} : { diagnostic: detail }),
      })
      this.remember(id, conversationId, plan.childCwd, label, plan.selection)
      try {
        const evidence = collectEvidence(baseline, id, evidenceStatus, conversationId,
          evidenceStatus === 'completed' ? undefined : detail)
        saveEvidence(evidence, config.evidenceDir)
        recorder?.evidence(evidence)
      } catch (error) {
        ctx.logger.warn(`${PREFIX}: failed to collect background evidence: ${String(error)}`)
      }
      if (conversationId !== undefined && this.runRecords.has(id)) {
        const record = this.runRecords.get(id) as TaskRecord
        await updateTaskRegistry(config, (records) => {
          records[id] = record
        }, ctx.logger)
        taskLine = `\n[task: ${id}]`
      } else {
        taskLine = '\n[task: (none — this agy build did not provide a conversation_id)]'
      }
      taskLine += `\n[review: pending; use ${config.evidenceToolName} with task ${id}]`
      if (recorder !== undefined) taskLine += `\n[trace: ${config.traceToolName} with id ${traceKey}]`
      // A stream-json build always streams the response text; only patch in
      // the final response when the fallback (json/text) mode delivered none.
      const finalResponse = live?.acc.response
      if (live !== undefined && !live.acc.sawDelta) {
        if (finalResponse !== undefined && finalResponse.length > 0) appendVisible(finalResponse)
        else if (!live.acc.sawTerminal) appendVisible(live.acc.fallbackText())
      }
      return { status, detail }
    })()

    const readOutput = (): string => {
      const delta = visible.slice(readOffset)
      readOffset = visible.length
      let text = delta
      if (taskLine.length > 0 && !taskLineEmitted) {
        taskLineEmitted = true
        text += (text.length > 0 && !text.endsWith('\n') ? '\n' : '') + taskLine
      }
      return text
    }

    const cancel = (): void => {
      cancelledByRequest = true
      controller.abort()
      terminate()
    }

    // Track for the tasks/cancel tools; released when the job settles.
    this.trackActive(id, {
      label, cwd: plan.childCwd, startedAt: Date.now(), background: true, cancel,
      ...(recorder !== undefined ? { traceKey } : {}),
    }, done)
    return { id, cancel, done, readOutput }
  }
}

// ── Model-facing tools ──────────────────────────────────────────────────────

/** Render text blocks from the canonical JSON block array without trusting arbitrary values. */
function outputValueText(values: unknown[]): string {
  return values
    .filter(
      (value) =>
        typeof value === 'object' && value !== null && !Array.isArray(value) &&
        (value as { type?: unknown }).type === 'text' && typeof (value as { text?: unknown }).text === 'string',
    )
    .map((value) => (value as { text: string }).text)
    .join('')
}

/** Render a millisecond duration compactly for model-facing text ("1 h", "5 min", "60 s"). */
function formatMs(ms: number): string {
  if (Number.isInteger(ms) && ms % 3_600_000 === 0) return `${ms / 3_600_000} h`
  if (Number.isInteger(ms) && ms % 60_000 === 0) return `${ms / 60_000} min`
  if (Number.isInteger(ms) && ms % 1000 === 0) return `${ms / 1000} s`
  return `${ms} ms`
}

/** Render an epoch-ms stamp as a compact UTC ISO string for model-facing lists. */
function formatStamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z')
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'antigravity run was cancelled'
    case 'error':
      return 'antigravity run failed'
    case 'max-tokens':
      return 'antigravity run hit its token limit before finishing'
    case 'refusal':
      return 'antigravity declined the task'
    default:
      return `antigravity run ended abnormally (${String(result.stopReason)})`
  }
}

/** Append the child's preserved partial answer to a stop-reason error. */
function withPartialText(error: string, output: readonly { type: string; text?: string }[]): string {
  const text = output.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('')
  return text.length === 0 ? error : `${error}\nPartial output before the run ended:\n${text}`
}

/** Collect and release one foreground run without letting disposal replace an independent result failure. */
async function settleForegroundRun(
  run: SubagentRun,
): Promise<{ kind: 'foreground'; runId: string; output: JsonValue[] }> {
  const [execution] = await Promise.allSettled([
    run.result.then((result) => {
      const error = stopReasonError(result)
      if (error !== undefined) throw new Error(withPartialText(error, result.output))
      return {
        kind: 'foreground' as const,
        runId: run.id,
        output: result.output as unknown as JsonValue[],
      }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError([execution.reason, disposal.reason], `antigravity run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`)
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}


function executionErrorStatus(error: unknown): ExecutionStatus {
  const message = String(error)
  if (/timed?\s*out|did not finish within|watchdog/i.test(message)) return 'timeout'
  if (/aborted|cancelled by request|canceled by request/i.test(message)) return 'cancelled'
  return 'failed'
}

/** Finish a run and persist local evidence whether it succeeded or failed. */
async function settleWithEvidence(
  run: SubagentRun,
  before: ReturnType<typeof captureWorkspace>,
  taskKey: string,
  provider: AntigravitySubagentProvider,
  config: Config,
): Promise<{ kind: 'foreground'; runId: string; output: JsonValue[]; evidence: ReturnType<typeof collectEvidence> }> {
  try {
    const settled = await settleForegroundRun(run)
    const conversationId = provider.recordOf(settled.runId)?.conversationId
    const evidence = collectEvidence(before, taskKey, 'completed', conversationId)
    saveEvidence(evidence, config.evidenceDir)
    return { ...settled, evidence }
  } catch (error) {
    const conversationId = provider.recordOf(run.id)?.conversationId
    const evidence = collectEvidence(before, taskKey, executionErrorStatus(error), conversationId, String(error))
    saveEvidence(evidence, config.evidenceDir)
    // Return failure as a structured terminal result, rather than discarding
    // the task key and evidence in a rejected tool invocation.
    return { kind: 'foreground', runId: run.id, output: [{ type: 'text', text: `AGY execution failed: ${String(error)}` }], evidence }
  }
}

function reviewSummary(value: JsonValue): string {
  const evidence = value as unknown as ReturnType<typeof collectEvidence>
  return '\n[Local evidence: ' + evidence.diff_summary.changed_files_total +
    ' files changed; execution=' + evidence.execution_status +
    '; review=pending; independent validation required]'
}
/** Model-facing rendering of one trace page: state first, then compact records. */
function renderTrace(id: string, source: string, summary: TraceSummary, events: TraceRecord[], nextCursor: number, hasMore: boolean, config: Config): string {
  const lines: string[] = []
  lines.push(`AGY trace ${id} (${summary.kind === 'native' ? 'native child' : summary.kind === 'chat' ? 'main chat session' : 'task'}) — ${source}`)
  const life = summary.lifecycle
  lines.push(`lifecycle: started=${life.started ? 'yes' : 'no'} execution=${life.execution} evidence=${life.evidence} review=pending (independent DSH verification required)`)
  const run = summary.current_run
  if (run !== null) {
    const parts = [`runs=${summary.runs}`, `current run ${String(run.run)}`, `mode=${String(run.mode)}`, `transport=${String(run.transport)}`]
    if (run.conversation_id) parts.push(`conversation=${String(run.conversation_id)}`)
    parts.push(`steps=${String(run.steps)}`, `tool_calls=${String(run.tool_calls)}`, `tool_errors=${String(run.tool_errors)}`)
    if (run.result_status) parts.push(`result=${String(run.result_status)}`)
    lines.push(parts.join(' '))
    const running = run.running_tool as { step?: unknown; tool?: unknown } | null
    if (running) lines.push(`running now: ${String(running.tool)} (step ${String(running.step)})`)
    const evidence = run.evidence as { task?: unknown; changed_files_total?: unknown; evidence_complete?: unknown } | null
    if (evidence) lines.push(`evidence: ${String(evidence.changed_files_total)} changed file(s), complete=${String(evidence.evidence_complete)} — details: ${config.evidenceToolName} task ${String(evidence.task)}`)
    const supervision = run.supervision as { allowed?: unknown; denied?: unknown; reworks?: unknown; tampered?: unknown; state?: unknown } | string | undefined
    if (supervision !== undefined && supervision !== 'off') {
      if (typeof supervision === 'string') lines.push(`supervision: ${supervision}`)
      else if (supervision.state !== undefined) lines.push(`supervision: enforced, ${String(supervision.state)}`)
      else lines.push(`supervision: enforced, allowed=${String(supervision.allowed)} denied=${String(supervision.denied)} reworks=${String(supervision.reworks)}${Array.isArray(supervision.tampered) && supervision.tampered.length > 0 ? ` TAMPERED: ${supervision.tampered.join(', ')}` : ''}`)
    }
  }
  const tools = Object.entries(summary.tools_used)
  if (tools.length > 0) lines.push('agy tools: ' + tools.map(([name, count]) => `${name}×${count.calls}${count.errors > 0 ? ` (${count.errors} error)` : ''}`).join(', '))
  if (summary.truncated) lines.push('note: trace reached its cap; later step records were dropped (lifecycle records kept)')
  lines.push(`records (${events.length} of ${summary.total_events}):`)
  for (const record of events) lines.push('  ' + renderTraceRecord(record))
  lines.push(`next_cursor: ${nextCursor}  has_more: ${hasMore ? 'true' : 'false'}`)
  return lines.join('\n')
}

export function apply(ctx: Context, config: Config): void {
  assertPositiveFinite(PREFIX, 'disposeGraceMs', config.disposeGraceMs)
  assertPositiveFinite(PREFIX, 'watchdogMarginMs', config.watchdogMarginMs)
  assertPositiveFinite(PREFIX, 'backgroundTimeoutMs', config.backgroundTimeoutMs)
  const configuredCwd = config.cwd.length > 0 ? validateConfiguredCwd(PREFIX, config.cwd) : undefined

  // Provider registration (effect-scoped: stop/update/unload removes it).
  const traces = config.traceEnabled
    ? new TraceStore(
      config.traceDir.length > 0 ? config.traceDir : join(pluginBaseDir() || join(homeDirectory(), '.dsh'), 'agy-traces'),
      { ...DEFAULT_TRACE_LIMITS, maxEventsPerTrace: config.traceMaxEvents, maxTraces: config.traceMaxFiles },
      (message) => ctx.logger.warn(`${PREFIX}: ${message}`),
    )
    : undefined
  const provider = new AntigravitySubagentProvider(ctx, config, configuredCwd, traces)
  ctx.effect(
    () => ctx.subagents.registerProvider(provider),
    `${PREFIX}: provider ${config.providerName}`,
  )

  if (config.nativeContinuableEnabled) {
    // DSH Session identity is the authoritative continuation key; AGY conversation
    // ids live in a separate local registry, never in the Git repository.
    const nativeIndexConfig: Config = {
      ...config,
      registryPath: config.nativeRegistryPath || join(pluginBaseDir(), 'agy-native-sessions.json'),
    }
    /**
     * Per-turn CLI arguments for the session's DSH route. DSH persists the route
     * (model + reasoningEffort) in the child descriptor; agy reverts to its
     * default model when resuming without --model, so the route is sent on
     * EVERY turn (spawnPlan maps it onto --model/--effort). agy-cli keeps the
     * plugin/CLI default exactly as before.
     */
    const nativeSelection = (model: string, reasoningEffort: string | undefined): { model?: string; effort?: string } =>
      model === NATIVE_MODEL_ID ? {} : { model, effort: reasoningEffort ?? '' }

    /** Route for a child that names no model: nativeDefaultModel/Effort, validated when the listing works. */
    const nativeDefaultRoute = async (): Promise<{ model: string; effort?: string; source: 'plugin-default' | 'cli-default' }> => {
      const model = config.nativeDefaultModel.trim()
      if (model.length === 0) return { model: NATIVE_MODEL_ID, source: 'cli-default' }
      const effort = config.nativeDefaultEffort.trim().toLowerCase() || undefined
      let models: AgyBaseModel[] | undefined
      try {
        models = await provider.models.list()
      } catch (error) {
        ctx.logger.warn(`${PREFIX}: cannot validate default AGY model ${model} (${error instanceof Error ? error.message : String(error)}); using it unvalidated`)
        return { model, ...(effort !== undefined ? { effort } : {}), source: 'plugin-default' }
      }
      try {
        const resolved = resolveSelection(models, model, effort)
        return { model: resolved.model.id, ...(resolved.effort !== undefined ? { effort: resolved.effort } : {}), source: 'plugin-default' }
      } catch (error) {
        ctx.logger.warn(`${PREFIX}: default AGY model ${model} is not available (${error instanceof Error ? error.message : String(error)}); falling back to the CLI default`)
        return { model: NATIVE_MODEL_ID, source: 'cli-default' }
      }
    }

    /**
     * Hand DSH image blocks to AGY as files: copy each from the DSH attachment
     * store into a per-session temp directory (passed with --add-dir) and refer
     * to its path, so AGY opens it with its own viewer (verified on 1.4.0).
     */
    const saveImages = async (messages: GenerateOptions['messages'], sessionId: string, signal: AbortSignal | undefined): Promise<{ dir?: string; paths: Map<string, string> }> => {
      const paths = new Map<string, string>()
      const blocks: { attachment: { attachmentId: string; mediaType: string } }[] = []
      for (const message of messages) {
        if (!Array.isArray(message.content)) continue
        for (const block of message.content as unknown[]) {
          const candidate = block as { type?: unknown; attachment?: { attachmentId?: unknown; mediaType?: unknown } }
          if (candidate?.type === 'image' && typeof candidate.attachment?.attachmentId === 'string' && typeof candidate.attachment.mediaType === 'string') {
            blocks.push(candidate as { attachment: { attachmentId: string; mediaType: string } })
          }
        }
      }
      if (blocks.length === 0) return { paths }
      const store = (ctx as unknown as { get(name: string): unknown }).get('attachments') as
        | { readImage(ref: unknown, signal?: AbortSignal): Promise<{ data: Uint8Array }> }
        | undefined
      if (store === undefined || typeof store.readImage !== 'function') return { paths }
      const root = join(tmpdir(), 'dsh-agy-images')
      pruneOldDirectories(root, 7 * 24 * 60 * 60 * 1000)
      const dir = join(root, createHash('sha256').update(sessionId).digest('hex').slice(0, 24))
      mkdirSync(dir, { recursive: true })
      for (const block of blocks) {
        const id = block.attachment.attachmentId
        if (paths.has(id)) continue
        const ext = block.attachment.mediaType === 'image/jpeg' ? 'jpg' : block.attachment.mediaType.replace(/^image\//, '').replace(/[^a-z0-9]/g, '') || 'img'
        const file = join(dir, `${createHash('sha256').update(id).digest('hex').slice(0, 24)}.${ext}`)
        try {
          if (!existsSync(file)) writeFileSync(file, (await store.readImage(block.attachment, signal)).data)
          paths.set(id, file)
        } catch (error) {
          ctx.logger.warn(`${PREFIX}: could not hand an image attachment to AGY: ${String(error)}`)
        }
      }
      return paths.size > 0 ? { dir, paths } : { paths }
    }
    const imagePlaceholder = (paths: Map<string, string>) => (block: { type: 'image'; attachment?: unknown }): string | undefined => {
      const ref = block.attachment as { attachmentId?: string; width?: number; height?: number; mediaType?: string; name?: string } | undefined
      const file = ref?.attachmentId !== undefined ? paths.get(ref.attachmentId) : undefined
      if (file === undefined) return undefined
      return `[Attached image${ref?.name ? ` "${ref.name}"` : ''} (${String(ref?.width ?? '?')}x${String(ref?.height ?? '?')}, ${ref?.mediaType ?? 'image'}) saved at ${file} — open it with your file viewing tool before answering about it.]`
    }

    const nativeAdapter = new NativeAgyLlmAdapter(config.nativeLlmProvider, async (options, sink?: NativeTextSink) => {
      const childId = options.sessionId
      if (!childId) throw new Error(`${PREFIX}: native adapter requires a DSH session id`)
      const child = ctx.agents.get(childId)
      if (!child) throw new Error(`${PREFIX}: native agent ${childId} is not resident`)
      // A DSH child (antigravity_native_start or DSH subagent delegation) keeps the
      // strict, fail-closed transport. A main session that picked an AGY model in
      // DSH's model list gets the lenient rendering (no DSH system prompt, DSH
      // tool traffic and oversized history omitted with notes).
      const isChild = (child.session.header as { origin?: string }).origin === 'subagent' || traces?.readMeta(childId)?.kind === 'native'
      if (!isChild && !config.nativeMainSessionEnabled) {
        throw new Error(`${PREFIX}: the AGY native transport only serves DSH child sessions (${config.nativeStartToolName}); nativeMainSessionEnabled is off`)
      }
      const cli = nativeSelection(options.model, options.reasoningEffort !== undefined ? String(options.reasoningEffort) : undefined)
      const signal = options.signal ?? new AbortController().signal
      const owner = isChild ? agentIdOf((child as { parentAgent?: unknown }).parentAgent) : (childId as string)
      const images = await saveImages(options.messages, childId, signal)
      const dirs = images.dir !== undefined ? [images.dir] : []
      const image = imagePlaceholder(images.paths)
      const onText = sink !== undefined ? { onText: (delta: string) => sink.text(delta) } : {}
      // AGY reports usage per model call; a DSH request is one AGY turn.
      const usage = new TurnUsage()
      const progress = !isChild && config.nativeChatToolProgress && sink !== undefined
      const onEvent = (event: AgyStreamEvent): void => {
        usage.observe(event)
        if (progress) {
          const line = chatProgressLine(event)
          if (line !== undefined) sink.text(line)
        }
      }
      const timeoutMs = config.nativeTimeoutMs

      // DSH auxiliary calls (session titles, compaction) share the session id but
      // are not conversation turns: run them one-shot so they never touch the
      // session's AGY conversation or its evidence.
      if (options.purpose !== undefined) {
        const text = nativePrompt(options, false, { mode: 'lenient', includeSystem: true, image }) +
          '\n\n(Auxiliary request from the host application: answer directly in text. Do not use any tools and do not modify files.)'
        const auxCwd = resolveChildCwd(PREFIX, configuredCwd, child.session.header.cwd)
        const run = await provider.startWithDirs({
          label: `AGY ${options.purpose}`, parent: child, prompt: [{ type: 'text' as const, text }], signal,
        }, dirs, { cwd: auxCwd, ...cli, timeoutMs, stream: { traceKey: `${childId}::${options.purpose}`, traceKind: isChild ? 'native' : 'chat', owner, mode: options.purpose, ...onText, onEvent: usage.observe } })
        try {
          const result = await run.result
          if (result.stopReason !== 'completed') {
            throw new Error(`${PREFIX}: AGY ${options.purpose} call ended with ${result.stopReason} (${result.diagnostic ?? 'no diagnostic'})`)
          }
          return { text: result.output.filter((block) => block.type === 'text').map((block) => block.text).join(''), ...usage.toDsh() }
        } finally {
          await run.dispose()
        }
      }

      const previous = loadTaskRegistry(nativeIndexConfig, ctx.logger)[childId]
      const cwd = previous?.cwd ?? resolveChildCwd(PREFIX, configuredCwd, child.session.header.cwd)
      const prompt = nativePrompt(options, previous !== undefined, { mode: isChild ? 'strict' : 'lenient', image })
      const request = {
        label: isChild ? 'AGY native child transport' : 'AGY native chat transport',
        parent: child,
        prompt: [{ type: 'text' as const, text: prompt }],
        signal,
      }
      // One trace per DSH session (child owner recorded in prepareContinuable;
      // a main session owns its own trace); each AGY turn is one run inside it.
      const stream: AgyRunStreamOptions = {
        traceKey: childId,
        // 'chat' keeps a main session from later being mistaken for a native child.
        traceKind: isChild ? 'native' : 'chat',
        childId,
        owner,
        mode: `${isChild ? 'native' : 'native-chat'}-${previous ? 'followup' : 'first'}`,
        ...onText,
        onEvent,
      }
      let before: ReturnType<typeof captureWorkspace> | undefined
      try {
        before = captureWorkspace(cwd)
      } catch (error) {
        ctx.logger.warn(`${PREFIX}: native evidence baseline failed: ${String(error)}`)
      }
      const run = previous
        ? await provider.followup(request, previous.conversationId, cwd, { stream, dirs, timeoutMs, ...cli })
        : await provider.startWithDirs(request, dirs, { cwd, stream, timeoutMs, ...cli })
      try {
        const result = await run.result
        if (before !== undefined) {
          // Local file evidence for this turn, linked to the session's trace.
          try {
            const status: ExecutionStatus = result.stopReason === 'completed' ? 'completed'
              : result.stopReason === 'aborted' ? 'cancelled'
              : executionErrorStatus(result.diagnostic ?? result.output.map((block) => (block.type === 'text' ? block.text : '')).join(''))
            const evidence = collectEvidence(before, run.id, status, provider.recordOf(run.id)?.conversationId,
              status === 'completed' ? undefined : (result.diagnostic ?? `native AGY transport ended with ${result.stopReason}`))
            saveEvidence(evidence, config.evidenceDir)
            provider.recordEvidence(childId, run.id, evidence)
          } catch (error) {
            ctx.logger.warn(`${PREFIX}: native evidence collection failed: ${String(error)}`)
          }
        }
        if (result.stopReason !== 'completed') {
          throw new Error(`${PREFIX}: native AGY transport ended with ${result.stopReason} (${result.diagnostic ?? 'no diagnostic'})`)
        }
        const record = provider.recordOf(run.id)
        if (!record?.conversationId) {
          throw new Error(`${PREFIX}: AGY gave no conversation_id; this session cannot promise durable conversation recovery`)
        }
        await updateTaskRegistry(nativeIndexConfig, (records) => {
          records[childId] = {
            conversationId: record.conversationId,
            cwd: record.cwd,
            label: isChild ? 'AGY native child' : 'AGY native chat',
            createdAt: previous?.createdAt ?? Date.now(),
          }
        }, ctx.logger)
        return { text: result.output.filter((block) => block.type === 'text').map((block) => block.text).join(''), ...usage.toDsh() }
      } finally {
        await run.dispose()
      }
    }, {
      list: async () => (await provider.models.list()).map((model) => {
        const effort = model.id === config.nativeDefaultModel && (model.efforts as string[]).includes(config.nativeDefaultEffort)
          ? config.nativeDefaultEffort : defaultEffortFor(model)
        const contextWindow = config.nativeContextWindows[model.id]
        return {
          id: model.id,
          name: model.name,
          efforts: model.efforts,
          ...(effort !== undefined ? { defaultEffort: effort } : {}),
          ...(typeof contextWindow === 'number' && contextWindow > 0 ? { contextWindow } : {}),
        }
      }),
    }, config.nativeImageInput)
    ctx.effect(
      () => ctx.llm.registerAdapter([config.nativeLlmProvider], nativeAdapter),
      `${PREFIX}: experimental native CLI model provider ${config.nativeLlmProvider}`,
    )
    ctx.effect(
      () => ctx.tools.register(defineTool({
        name: config.nativeStartToolName,
        description: 'EXPERIMENTAL: Create a REAL DSH continuable child Session/Agent backed by logged-in Antigravity CLI. Child appears in native subagent tree and accepts host send_message; the CLI uses its own tools, not DSH tools. Starts asynchronously; AGY\'s visible text streams into the child Session' + (traces !== undefined ? ', and its step/tool execution record is readable with ' + config.traceToolName + ' (id = childId) while it runs' : '') + '. Workspace is the parent DSH session cwd. Does not report fake completion; verify changes yourself.',
        parameters: {
          description: { type: 'string', required: true, description: 'Short label displayed in DSH native subagent tree.' },
          prompt: { type: 'string', required: true, description: 'Full standalone AGY task; use only the current parent workspace.' },
          model: { type: 'string', description: 'Optional AGY model id from ' + config.modelsToolName + ' (base id like gemini-3.8-flash, or a CLI variant id like gemini-3.8-flash-low). Omit to use the CLI default model and effort. Locked for this child: every later turn re-sends it.' },
          effort: { type: 'string', description: 'Optional effort for a model with effort variants (see ' + config.modelsToolName + '); requires model.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              childId: { type: 'string', required: true },
              messageId: { type: 'string', required: true },
              state: { type: 'string', required: true },
              model: { type: 'string', required: true },
              effort: { type: 'string' },
              model_source: { type: 'string', required: true },
            },
          },
          render: (_args: unknown, result: { childId: string; state: string; model: string; effort?: string; model_source: string }) => [
            { type: 'text', text: `Native AGY child session ${result.childId}: ${result.state}. Requested AGY model: ${result.model === NATIVE_MODEL_ID ? 'CLI default model and effort' : result.model + (result.effort ? ` (effort ${result.effort})` : '')} [${result.model_source}; requested value — the effective model is reported in the trace when supervision is on]. Check native subagent tree; use DSH send_message for follow-ups.${traces !== undefined ? ` Live AGY step/tool record: ${config.traceToolName} with id ${result.childId}.` : ''}` },
          ],
        },
        isConcurrencySafe: () => true,
        async execute(args: { description: string; prompt: string; model?: string; effort?: string }, exec: ToolRunContext) {
          const parent = exec.agent
          if (!parent) throw new Error(`${PREFIX}: native start requires a calling DSH Agent`)
          if (!args.prompt.trim()) throw new Error(`${PREFIX}: native prompt must not be empty`)
          // Validate BEFORE the child exists; the choice then lives in DSH's own descriptor.
          const requestedModel = args.model?.trim() || undefined
          const requestedEffort = args.effort?.trim().toLowerCase() || undefined
          let route: { model: string; effort?: string; source: 'explicit' | 'plugin-default' | 'cli-default' }
          if (requestedModel === NATIVE_MODEL_ID) {
            if (requestedEffort !== undefined) {
              throw new Error(`${PREFIX}: effort requires an explicit model (${NATIVE_MODEL_ID} runs the CLI's own default model and effort); see ${config.modelsToolName}`)
            }
            route = { model: NATIVE_MODEL_ID, source: 'cli-default' }
          } else if (requestedModel === undefined) {
            if (requestedEffort !== undefined) {
              throw new Error(`${PREFIX}: effort requires an explicit model; see ${config.modelsToolName}`)
            }
            route = await nativeDefaultRoute()
          } else {
            let models: AgyBaseModel[]
            try {
              models = await provider.models.list()
            } catch (error) {
              throw new Error(`${PREFIX}: cannot verify AGY model "${requestedModel}": ${error instanceof Error ? error.message : String(error)}. Retry, or omit model to use the CLI default.`)
            }
            try {
              const resolved = resolveSelection(models, requestedModel, requestedEffort)
              route = { model: resolved.model.id, ...(resolved.effort !== undefined ? { effort: resolved.effort } : {}), source: 'explicit' }
            } catch (error) {
              if (error instanceof AgyModelSelectionError) throw new Error(`${PREFIX}: ${error.message}`)
              throw error
            }
          }
          const childId = randomUUID() as SessionId
          const result = await ctx.subagents.startContinuable({
            provider: config.providerName,
            label: args.description,
            childId,
            request: {
              parent,
              prompt: [{ type: 'text', text: args.prompt }],
              agentOptions: {
                provider: config.nativeLlmProvider,
                model: route.model,
                ...(route.effort !== undefined ? { reasoningEffort: ReasoningEffortId(route.effort) } : {}),
              },
              toolFilter: { allow: [] },
            },
            signal: exec.signal,
          })
          return {
            childId: result.childId, messageId: result.messageId, state: 'accepted',
            model: route.model, ...(route.effort !== undefined ? { effort: route.effort } : {}), model_source: route.source,
          }
        },
      })),
      `${PREFIX}: experimental native start tool ${config.nativeStartToolName}`,
    )
  }

  // Terminate every in-flight agy process when the plugin stops or updates —
  // they would otherwise leak as orphans no other provider can manage.
  ctx.effect(
    () => () => {
      try {
        const terminated = provider.terminateAllActive()
        if (terminated > 0) ctx.logger.warn(`${PREFIX}: terminated ${terminated} active agy run(s) on plugin stop`)
      } catch (error) {
        console.warn(`${PREFIX}: error terminating active runs on plugin stop: ${String(error)}`)
      }
    },
    `${PREFIX}: terminate active runs on dispose`,
  )

  // New-task tool (effect-scoped like the provider).
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: config.toolName,
          description:
            'Delegate a self-contained task to Google Antigravity CLI (agy) — a separate Gemini-powered coding agent on this machine, authenticated with your Antigravity account (no API key). It works in the parent session\'s workspace and returns its final answer; give it a complete, standalone prompt because it does not see this conversation. The result carries a `task` key: pass it to antigravity_followup to continue this conversation later. If the task targets files OUTSIDE the session workspace (e.g. another project), pass their absolute directory paths in `dirs` — without it, headless agy cannot reach them and will hang until its timeout. Every prompt gets appended environment notes telling agy NOT to use its headless browser tools (they can hang; config `avoidBrowser`, default true) and NOT to read files larger than 1 MB with its read tool (it fails above 4 MB; config `avoidLargeReads`, default true — agy should use grep/sed/run_command instead). When a task genuinely needs a browser preview, say so and have the user set avoidBrowser: false. If a run fails with "authentication required", a login window opens automatically on the machine (config autoLoginWindow, default true) — tell the user to complete the sign-in, or call ' + config.loginToolName + ' to open it manually. Foreground runs are cut off at a ' + formatMs(config.printTimeoutMs) + ' ceiling (agy --print-timeout; configurable via printTimeoutMs) and force-killed ' + formatMs(config.watchdogMarginMs) + ' later if hung. For long tasks use `background: true` and keep the user informed: poll job_output every ~60 seconds and report agy\'s live progress (see the background parameter), then the final result — never wait silently or end the turn while the job runs. List running/recent tasks with ' + config.tasksToolName + ', and stop a running one with ' + config.cancelToolName + '.',
          parameters: {
            description: {
              type: 'string',
              required: true,
              description: 'A short (3-5 word) description of the delegated task, for display.',
            },
            prompt: {
              type: 'string',
              required: true,
              description:
                'The complete, self-contained task for Antigravity. It does not share this conversation\'s context, so include everything it needs (files, paths, acceptance criteria, and what to return). Keep it under 30000 characters.',
            },
            cwd: { type: 'string', description: 'Optional absolute target working directory; evidence is collected here.' },
            model: { type: 'string', description: 'Optional AGY model id from ' + config.modelsToolName + ' (overrides the plugin/CLI default; follow-ups keep it).' },
            effort: { type: 'string', description: 'Optional effort for a model with effort variants (see ' + config.modelsToolName + ').' },
            dirs: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Optional absolute paths of directories to add to the agy workspace (--add-dir), for targets OUTSIDE the session workspace. Headless agy cannot answer the interactive "add directory to workspace?" prompt, so without this it hangs until its print timeout. Pass [] when not needed.',
            },
            background: {
              type: 'boolean',
              description:
                'Optional. Set true to run in the background: the call returns a job id immediately; read live output with job_output (wait: true blocks until it finishes) and stop with job_kill. The final output includes a [task: ...] line for antigravity_followup. Background runs use the generous ' + formatMs(config.backgroundTimeoutMs) + ' ceiling (backgroundTimeoutMs) instead of the ' + formatMs(config.printTimeoutMs) + ' foreground ceiling. IMPORTANT — keep the user informed during the run: after starting a long background job, do NOT wait silently. Poll job_output roughly every 60 seconds and briefly tell the user what agy is doing (streamed text and [agy: ...] step markers), then report the final result when the job completes. Do not end your turn while the job runs — the session would go silent (the completion wake-up is budgeted). For short jobs (under ~2 minutes) a single job_output with wait: true is fine. Each poll costs tokens, so keep progress updates brief.',
            },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                runId: { type: 'string' },
                task: { type: 'string' },
                jobId: { type: 'string' },
                output: { type: 'array', items: { type: 'json' } },
                evidence: { type: 'json' }
              },
            },
            render: (_args: unknown, value: { kind?: string; jobId?: string; task?: string; output?: unknown[]; evidence?: JsonValue }) => {
              if (value.kind === 'background') {
                return [{ type: 'text', text: `started background job ${value.jobId ?? '(unknown)'} (AGY task ${value.task ?? '(unknown)'}) — read live output with job_output, stop with job_kill${traces !== undefined ? `, structured AGY step/tool record with ${config.traceToolName}` : ''}` }]
              }
              return [{ type: 'text', text: outputValueText(value.output ?? []) + (value.evidence ? reviewSummary(value.evidence) : '') }]
            },
          },
          isConcurrencySafe: () => true,
          async execute(args: { description: string; prompt: string; cwd?: string; model?: string; effort?: string; dirs?: string[]; background?: boolean }, exec: ToolRunContext) {
            const parent = exec.agent
            if (!parent) throw new Error(`${PREFIX}: antigravity tool requires a calling agent (exec.agent was undefined)`)
            const provider = ctx.subagents.getProvider(config.providerName) as AntigravitySubagentProvider | undefined
            if (!(provider instanceof AntigravitySubagentProvider)) {
              throw new Error(`${PREFIX}: provider "${config.providerName}" is not the antigravity provider`)
            }
            if (args.background === true) {
              const jobs = ctx.get('jobs')
              if (jobs === undefined) {
                throw new Error(`${PREFIX}: background jobs unavailable — load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs`)
              }
              const run = await ctx.subagents.start(config.providerName, {
                label: args.description,
                prompt: [{ type: 'text' as const, text: args.prompt }],
                parent,
                signal: exec.signal,
                agyOptions: { cwd: args.cwd, model: args.model, effort: args.effort, dirs: args.dirs, background: true },
              } as AgyNativeRequest)
              if (!hasAgyBackground(run)) {
                await run.dispose()
                throw new Error(`${PREFIX}: native manager did not receive an AGY background run`)
              }
              let jobId: string
              try {
                // DSH 0.2 Jobs owner is SessionId. Its output pump uses byte-offset reads.
                const runtimeJobs = jobs as unknown as {
                  start(spec: {
                    kind: 'antigravity'
                    label: string
                    owner: SessionId
                    output: ReturnType<typeof backgroundOutputSource>[]
                    run: () => { cancel: (reason?: string) => void; done: AntigravityBackgroundHandle['done'] }
                  }): string
                }
                jobId = runtimeJobs.start({
                  kind: 'antigravity',
                  label: args.description,
                  owner: parent.id,
                  output: [run.agyBackground.output],
                  run: () => ({
                    cancel: (reason?: string) => {
                      run.agyBackground.cancel(reason)
                      void run.dispose().catch((err: unknown) => ctx.logger.warn(`${PREFIX}: background dispose failed: ${String(err)}`))
                    },
                    done: run.agyBackground.done,
                  }),
                })
              } catch (error) {
                await run.dispose()
                throw error
              }
              return { kind: 'background', jobId, task: run.id }
            }
            const before = captureWorkspace(resolveChildCwd(PREFIX, args.cwd ? validateConfiguredCwd(PREFIX, args.cwd) : configuredCwd, parent.session.header.cwd))
            const run = await ctx.subagents.start(config.providerName, {
              label: args.description,
              prompt: [{ type: 'text' as const, text: args.prompt }],
              parent,
              signal: exec.signal,
              agyOptions: { cwd: args.cwd, model: args.model, effort: args.effort, dirs: args.dirs },
            } as AgyNativeRequest)
            const settled = await settleWithEvidence(run, before, run.id, provider, config)
            if (args.dirs?.length) settled.evidence.warnings.push('Additional --add-dir paths are not covered by workspace evidence.')
            saveEvidence(settled.evidence, config.evidenceDir)
            provider.recordEvidence(settled.runId, settled.runId, settled.evidence)
            const record = provider.recordOf(settled.runId)
            if (record !== undefined) {
              await updateTaskRegistry(config, (records) => {
                records[settled.runId] = record
              }, ctx.logger)
            }
            return { ...settled, task: settled.runId, evidence: JSON.parse(JSON.stringify(settled.evidence)) as JsonValue }
          },
        }),
      ),
    `${PREFIX}: tool ${config.toolName}`,
  )

  // Follow-up tool: resume an agy conversation by its recorded task key.
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: config.followupToolName,
          description:
            'Continue a previous Antigravity (agy) task in the same conversation: the child agent resumes with its full prior context. Use the `task` key returned by the antigravity tool (foreground result or the [task: ...] line of a background job), or list recorded keys with ' + config.tasksToolName + ' (they survive DSH restarts). Each follow-up is one new prompt in that conversation; the response is the agent\'s final text for this turn. Same ' + formatMs(config.printTimeoutMs) + ' run ceiling as the antigravity tool; keep prompts under 30000 characters.',
          parameters: {
            description: {
              type: 'string',
              required: true,
              description: 'A short (3-5 word) description of this follow-up, for display.',
            },
            task: {
              type: 'string',
              required: true,
              description: 'The `task` key returned by a previous antigravity call.',
            },
            prompt: {
              type: 'string',
              required: true,
              description: 'The follow-up instruction. The agent already remembers the whole prior task and its work; state only what is new.',
            },
            model: { type: 'string', description: 'Optional AGY model ID for this follow-up.' },
            effort: { type: 'string', description: 'Optional low | medium | high | xhigh | max reasoning effort.' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'foreground' },
                runId: { type: 'string', required: true },
                task: { type: 'string', required: true },
                output: { type: 'array', required: true, items: { type: 'json' } },
                evidence: { type: 'json', required: true }
              },
            },
            render: (_args: unknown, value: { output: unknown[]; evidence: JsonValue }) => [{ type: 'text', text: outputValueText(value.output) + reviewSummary(value.evidence) }],
          },
          isConcurrencySafe: () => true,
          async execute(args: { description: string; task: string; prompt: string; model?: string; effort?: string }, exec: ToolRunContext) {
            const parent = exec.agent
            if (!parent) throw new Error(`${PREFIX}: antigravity_followup tool requires a calling agent (exec.agent was undefined)`)
            const provider = ctx.subagents.getProvider(config.providerName) as AntigravitySubagentProvider | undefined
            if (!(provider instanceof AntigravitySubagentProvider)) {
              throw new Error(`${PREFIX}: provider "${config.providerName}" is not the antigravity provider`)
            }
            const records = loadTaskRegistry(config)
            const record = records[args.task]
            if (record === undefined) {
              throw new Error(
                `${PREFIX}: no such task "${args.task}" — run the antigravity tool first (task keys survive DSH restarts via ~/.dsh/agy-conversations.json)`,
              )
            }
            const before = captureWorkspace(record.cwd)
            const run = await ctx.subagents.start(config.providerName, {
              label: args.description,
              prompt: [{ type: 'text' as const, text: args.prompt }],
              parent,
              signal: exec.signal,
              // agy resumes on its DEFAULT model unless --model is sent again: keep the
              // conversation's recorded model/effort unless the caller overrides them
              // (a new model drops the old effort, which may not exist for it).
              agyOptions: {
                conversationId: record.conversationId, cwd: record.cwd, traceKey: args.task,
                ...(args.model !== undefined
                  ? { model: args.model, ...(args.effort !== undefined ? { effort: args.effort } : {}) }
                  : {
                    ...(record.model !== undefined ? { model: record.model } : {}),
                    ...(args.effort !== undefined ? { effort: args.effort } : record.effort !== undefined ? { effort: record.effort } : {}),
                  }),
              },
            } as AgyNativeRequest)
            const settled = await settleWithEvidence(run, before, args.task, provider, config)
            provider.recordEvidence(args.task, settled.runId, settled.evidence)
            const refreshed = provider.recordOf(settled.runId)
            await updateTaskRegistry(config, (records) => {
              records[args.task] = refreshed !== undefined
                ? { ...refreshed, cwd: record.cwd, label: record.label, createdAt: Date.now() }
                : { ...record, createdAt: Date.now() }
            }, ctx.logger)
            return { ...settled, task: args.task, evidence: JSON.parse(JSON.stringify(settled.evidence)) as JsonValue }
          },
        }),
      ),
    `${PREFIX}: tool ${config.followupToolName}`,
  )


  // Machine-readable evidence from the LOCAL working tree, never from AGY's self-report.
  ctx.effect(
    () => ctx.tools.register(
      defineTool({
        name: config.evidenceToolName,
        description: 'Read independently collected file-change evidence for a finished AGY task. review_status is always pending; verify functions and run tests yourself before accepting.',
        parameters: {
          task: { type: 'string', required: true, description: 'AGY task key returned by antigravity or antigravity_followup.' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { evidence: { type: 'json', required: true } },
          },
          render: (_args: unknown, result: { evidence: JsonValue }) =>
            [{ type: 'text', text: JSON.stringify(result.evidence, null, 2) }],
        },
        isConcurrencySafe: () => true,
        async execute(args: { task: string }) {
          const evidence = readEvidence(args.task, config.evidenceDir)
          if (!evidence) throw new Error(`${PREFIX}: no evidence for task "${args.task}" (job may still be running, or was started before evidence collection was enabled)`)
          return { evidence: JSON.parse(JSON.stringify(evidence)) as JsonValue }
        },
      }),
    ),
    `${PREFIX}: tool ${config.evidenceToolName}`,
  )

  // Trace tool: AGY's own execution record (steps, AGY-internal tool calls,
  // results, cancellation, linked local evidence), paged by seq cursor.
  if (traces !== undefined) {
    ctx.effect(
      () => ctx.tools.register(
        defineTool({
          name: config.traceToolName,
          description:
            'Read the durable execution trace of an Antigravity (agy) run you delegated, live or finished: AGY\'s own steps, AGY-INTERNAL tool calls (tool name, redacted parameters, output preview, errors), the final result, cancellation/timeout, optional supervision decisions (denied tool calls, stop-check rework), and the linked local file evidence. Pass a native child id (from ' + config.nativeStartToolName + ') or a task key (from ' + config.toolName + ', background jobs, or ' + config.followupToolName + '). Records come from agy stream-json: they are NOT DSH tool calls, AGY hidden reasoning is not available, and lifecycle.review is always pending — verify files, build and tests yourself (' + config.evidenceToolName + ' gives the file diff). Page with cursor = the previous next_cursor while a run is live. Only the delegating agent can read a trace.',
          parameters: {
            id: { type: 'string', required: true, description: 'Native child id or AGY task key.' },
            cursor: { type: 'number', description: 'Return only records with seq greater than this (default 0 = from the start).' },
            limit: { type: 'number', description: 'Maximum records to return (default 40, max 200).' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                source: { type: 'string', required: true },
                summary: { type: 'json', required: true },
                events: { type: 'array', required: true, items: { type: 'json' } },
                next_cursor: { type: 'number', required: true },
                has_more: { type: 'boolean', required: true },
              },
            },
            render: (_args: unknown, value: { id: string; source: string; summary: JsonValue; events: unknown[]; next_cursor: number; has_more: boolean }) =>
              [{ type: 'text', text: renderTrace(value.id, value.source, value.summary as unknown as TraceSummary, value.events as TraceRecord[], value.next_cursor, value.has_more, config) }],
          },
          isConcurrencySafe: () => true,
          async execute(args: { id: string; cursor?: number; limit?: number }, exec: ToolRunContext) {
            const caller = agentIdOf(exec.agent)
            if (caller === null) throw new Error(`${PREFIX}: ${config.traceToolName} requires a calling DSH agent`)
            const all = traces.readAll(args.id)
            // Same message for "absent" and "not yours": traces never leak to other agents.
            if (all === undefined || all.meta.owner === null || all.meta.owner !== caller) {
              throw new Error(`${PREFIX}: no trace "${args.id}" accessible to this agent (only the delegating parent can read it; traces exist for runs started with tracing enabled)`)
            }
            const current = ctx.subagents.getProvider(config.providerName) as AntigravitySubagentProvider | undefined
            const active = current instanceof AntigravitySubagentProvider ? current.activeRunsFor(args.id) : new Set<string>()
            const cursor = Math.max(0, Math.floor(Number.isFinite(args.cursor) ? (args.cursor as number) : 0))
            const limit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(args.limit) ? (args.limit as number) : 40)))
            const after = all.records.filter((record) => record.seq > cursor)
            const events = after.slice(0, limit)
            return {
              id: args.id,
              source: 'agy-cli stream-json (AGY-internal execution records; not DSH tool calls; hidden model reasoning is not exposed)',
              summary: JSON.parse(JSON.stringify(summarizeTrace(all.meta, all.records, active))) as JsonValue,
              events: JSON.parse(JSON.stringify(events)) as JsonValue[],
              next_cursor: events.at(-1)?.seq ?? cursor,
              has_more: after.length > events.length,
            }
          },
        }),
      ),
      `${PREFIX}: tool ${config.traceToolName}`,
    )
  }

  // Models tool: what "agy models" actually reports (no agent turn, no quota).
  ctx.effect(
    () => ctx.tools.register(
      defineTool({
        name: config.modelsToolName,
        description: 'List the Antigravity CLI models this machine can use, straight from "agy models" (no agent turn, no quota). Effort variants are grouped: pass the base id as model and one of its efforts as effort (or pass a CLI variant id such as gemini-3.8-flash-low). Models without efforts take no effort. ' + NATIVE_MODEL_ID + ' means the CLI default model and effort. Use the ids with ' + config.nativeStartToolName + ' or the model/effort parameters of ' + config.toolName + '.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              default_model: { type: 'string', required: true },
              models: { type: 'array', required: true, items: { type: 'json' } },
            },
          },
          render: (_args: unknown, value: { default_model: string; models: { id: string; name: string; efforts: string[]; default_effort: string | null; cli_ids: string[] }[] }) => [{
            type: 'text',
            text: [
              `AGY models (from "agy models"); ${value.default_model} = CLI default model and effort (no --model/--effort):`,
              ...value.models.map((model) => `- ${model.id} — ${model.name}; ${model.efforts.length > 0 ? `efforts: ${model.efforts.join(' | ')} (default ${model.default_effort ?? '-'})` : 'no effort variants'}; CLI ids: ${model.cli_ids.join(', ')}`),
            ].join('\n'),
          }],
        },
        isConcurrencySafe: () => true,
        async execute() {
          let models: AgyBaseModel[]
          try {
            models = await provider.models.list()
          } catch (error) {
            throw new Error(`${PREFIX}: could not list AGY models: ${error instanceof Error ? error.message : String(error)}. You can still pass a CLI model id from \`agy models\` directly; agy rejects unknown ids.`)
          }
          return {
            default_model: NATIVE_MODEL_ID,
            models: models.map((model) => ({
              id: model.id, name: model.name, efforts: model.efforts,
              default_effort: defaultEffortFor(model) ?? null, cli_ids: model.variants,
            })) as unknown as JsonValue[],
          }
        },
      }),
    ),
    `${PREFIX}: tool ${config.modelsToolName}`,
  )

  // Login-window tool: pop agy's interactive login on demand (also happens
  // automatically on auth failures when `autoLoginWindow` is on).
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: config.loginToolName,
          description:
            'Open the interactive Antigravity (agy) login window so the user can authenticate on the spot (Google sign-in; Windows opens a new console running agy). Call this when an antigravity run failed with "authentication required" and no window opened automatically.',
          parameters: {},
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                message: { type: 'string', required: true },
              },
            },
            render: (_args: unknown, value: { message: string }) => [{ type: 'text', text: value.message }],
          },
          isConcurrencySafe: () => true,
          async execute() {
            const provider = ctx.subagents.getProvider(config.providerName) as AntigravitySubagentProvider | undefined
            if (!(provider instanceof AntigravitySubagentProvider)) {
              throw new Error(`${PREFIX}: provider "${config.providerName}" is not the antigravity provider`)
            }
            return { message: await provider.launchLogin() }
          },
        }),
      ),
    `${PREFIX}: tool ${config.loginToolName}`,
  )

  // Tasks tool: list in-flight runs plus durable registry history. This is
  // the only restart-safe way to recover a `task` key for the follow-up tool.
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: config.tasksToolName,
          description:
            'List Antigravity (agy) tasks: currently running tasks (foreground and background) plus recently finished tasks from the durable registry (~/.dsh/agy-conversations.json, or registryPath). Task keys survive DSH restarts — use a `task` key with ' +
            config.followupToolName +
            ' to resume that conversation, or pass one to ' +
            config.cancelToolName +
            ' to stop a running task.',
          parameters: {
            limit: {
              type: 'number',
              description: 'How many recently finished tasks to include, newest first (default 20, max 50).',
            },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                running: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      task: { type: 'string', required: true },
                      label: { type: 'string', required: true },
                      cwd: { type: 'string', required: true },
                      background: { type: 'boolean', required: true },
                      startedAt: { type: 'number', required: true },
                    },
                  },
                },
                recent: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      task: { type: 'string', required: true },
                      label: { type: 'string', required: true },
                      cwd: { type: 'string', required: true },
                      createdAt: { type: 'number', required: true },
                    },
                  },
                },
              },
            },
            render: (_args: unknown, value: { running?: unknown[]; recent?: unknown[] }) => {
              const lines: string[] = []
              const running = value.running ?? []
              const recent = value.recent ?? []
              if (running.length === 0) {
                lines.push('No running tasks.')
              } else {
                lines.push(`Running (${running.length}):`)
                for (const entry of running) {
                  const item = entry as { task?: unknown; label?: unknown; background?: unknown; startedAt?: unknown }
                  lines.push(
                    `  task: ${String(item.task ?? '?')}  label: ${String(item.label ?? '')}  mode: ${item.background === true ? 'background' : 'foreground'}  started: ${formatStamp(typeof item.startedAt === 'number' ? item.startedAt : 0)}`,
                  )
                }
              }
              if (recent.length === 0) {
                lines.push('No recent finished tasks in the registry.')
              } else {
                lines.push(`Recent finished (${recent.length}):`)
                for (const entry of recent) {
                  const item = entry as { task?: unknown; label?: unknown; createdAt?: unknown }
                  lines.push(
                    `  task: ${String(item.task ?? '?')}  label: ${String(item.label ?? '')}  created: ${formatStamp(typeof item.createdAt === 'number' ? item.createdAt : 0)}`,
                  )
                }
              }
              return [{ type: 'text', text: lines.join('\n') }]
            },
          },
          isConcurrencySafe: () => true,
          async execute(args: { limit?: number }) {
            const current = ctx.subagents.getProvider(config.providerName) as AntigravitySubagentProvider | undefined
            if (!(current instanceof AntigravitySubagentProvider)) {
              throw new Error(`${PREFIX}: provider "${config.providerName}" is not the antigravity provider`)
            }
            const running = current.listActive()
            const records = loadTaskRegistry(config, ctx.logger)
            const limit = Math.max(0, Math.min(50, Math.floor(args.limit ?? 20)))
            const recent = Object.entries(records)
              .sort((a, b) => b[1].createdAt - a[1].createdAt)
              .slice(0, limit)
              .map(([task, record]) => ({ task, label: record.label, cwd: record.cwd, createdAt: record.createdAt }))
            return { running, recent }
          },
        }),
      ),
    `${PREFIX}: tool ${config.tasksToolName}`,
  )

  // Cancel tool: stop a running task by its task key; the agy process tree
  // is terminated and the run settles as cancelled (its conversation record,
  // if any, stays in the registry for later follow-up).
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: config.cancelToolName,
          description:
            'Stop a running Antigravity (agy) task by its task key. Get running task keys from ' +
            config.tasksToolName +
            ' (or the `task` field of an in-flight antigravity call). The agy process tree is terminated and the run settles as cancelled; its conversation record (if any) is kept for follow-up.',
          parameters: {
            task: {
              type: 'string',
              required: true,
              description: 'The task key of a RUNNING task (see ' + config.tasksToolName + ').',
            },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                cancelled: { type: 'boolean', required: true },
                task: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
            render: (_args: unknown, value: { message: string }) => [{ type: 'text', text: value.message }],
          },
          isConcurrencySafe: () => true,
          async execute(args: { task: string }) {
            const current = ctx.subagents.getProvider(config.providerName) as AntigravitySubagentProvider | undefined
            if (!(current instanceof AntigravitySubagentProvider)) {
              throw new Error(`${PREFIX}: provider "${config.providerName}" is not the antigravity provider`)
            }
            const cancelled = current.cancelActive(args.task)
            if (!cancelled) {
              throw new Error(
                `${PREFIX}: no running task "${args.task}" — running tasks are listed by ${config.tasksToolName}; finished tasks cannot be cancelled (their conversations resume via ${config.followupToolName})`,
              )
            }
            return {
              cancelled: true,
              task: args.task,
              message: `Cancellation requested for task ${args.task} — its run settles as cancelled.`,
            }
          },
        }),
      ),
    `${PREFIX}: tool ${config.cancelToolName}`,
  )

  ctx.logger.info(
    `${PREFIX}: provider "${config.providerName}" + tools "${config.toolName}" / "${config.followupToolName}" / "${config.tasksToolName}" / "${config.cancelToolName}"${traces !== undefined ? ` / "${config.traceToolName}"` : ''} / "${config.modelsToolName}" ready (command: ${config.command}${config.model ? `, model: ${config.model}` : ''})`,
  )
}
