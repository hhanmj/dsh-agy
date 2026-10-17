/** Shared offline test doubles: a scripted agy process behind a fake ctx.subprocess seam. */
import { PassThrough } from 'node:stream'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, Config } from '../../lib/index.js'
import { subprocess as nodeSubprocess } from './node-subprocess.mjs'

const MOCK_STREAM = join(dirname(fileURLToPath(import.meta.url)), 'mock-agy-stream.mjs')

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Split text into fixed-size BYTE chunks so multi-byte UTF-8 characters straddle chunk boundaries. */
export function byteChunks(text, size) {
  const bytes = Buffer.from(text, 'utf8')
  const out = []
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size))
  return out
}

export function reader(get) {
  return { readFrom: (from) => { const text = get(); return { text: text.slice(from), nextOffset: Buffer.byteLength(text), lossy: false } } }
}

export const HELP = '--add-dir  Add dir\n--conversation  Resume\n--dangerously-skip-permissions  x\n--output-format  Output format for print mode (text, json, stream-json)\n--print  Run a prompt\n--print-timeout  t\n--sandbox  s\n'
/** agy 1.4.0 help additionally documents streaming input. */
export const HELP_STREAM = HELP + '--input-format  Input format for print mode (text, stream-json). stream-json reads one NDJSON message per line from stdin\n'

/** Scripted agy process: emits stdout chunks, then exits (or hangs until terminate). */
export function scriptedHandle(spec, plan) {
  const piped = spec.stdio.stdout === 'pipe'
  const stdout = new PassThrough()
  let collectedStdout = ''
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  let finished = false
  const finish = (outcome) => {
    if (finished) return
    finished = true
    stdout.end()
    setImmediate(() => resolveDone(outcome))
  }
  // stdin 'pipe': capture what the plugin writes (stream-json prompt delivery).
  const stdin = spec.stdio.stdin === 'pipe' ? new PassThrough() : undefined
  let stdinText = ''
  stdin?.on('data', (chunk) => { stdinText += chunk.toString('utf8') })
  const handle = {
    stdin, stderr: undefined, control: undefined,
    get stdinText() { return stdinText },
    get stdinEnded() { return stdin?.writableEnded === true },
    stdout: piped ? stdout : undefined,
    collected: {
      stderr: reader(() => plan.stderr ?? ''),
      ...(piped ? {} : { stdout: reader(() => collectedStdout) }),
    },
    done,
    terminated: false,
    terminate() { handle.terminated = true; finish({ exitCode: null, signal: 'SIGTERM' }) },
    async waitForExit() { await done; return true },
  }
  spec.signal?.addEventListener('abort', () => handle.terminate(), { once: true })
  ;(async () => {
    for (const chunk of plan.chunks ?? []) {
      if (plan.delayMs) await sleep(plan.delayMs)
      else await new Promise((resolve) => setImmediate(resolve))
      if (finished) return
      if (piped) stdout.write(chunk)
      else collectedStdout += chunk.toString()
    }
    if (plan.hang) return
    plan.beforeExit?.(spec)
    finish({ exitCode: plan.exitCode ?? 0, signal: null })
  })()
  return handle
}

/** Real "agy models" output captured from agy 1.4.0. */
export const MODELS = 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n'

function collectedHandle(stdout, exitCode = 0, stderr = '') {
  return { stdout: undefined, collected: { stdout: reader(() => stdout), stderr: reader(() => stderr) }, done: Promise.resolve({ exitCode, signal: null }), terminate() {}, async waitForExit() { return true } }
}

/**
 * Minimal Cordis-like ctx with a fake ctx.subprocess seam driving scripted agy runs.
 * options.models: "agy models" stdout, or { fail: 'message' } to simulate a failing listing.
 * options.help: `agy help` text; options.streamMock: run --input-format argv against the real mock CLI.
 */
export function harness(dir, plans, extraConfig = {}, options = {}) {
  const tools = new Map()
  const spawns = []
  const continuable = []
  const modelCalls = []
  const streamSpawns = []
  let provider
  let adapter
  const agents = new Map()
  const ctx = {
    effect(fn) { return fn() },
    subagents: {
      registerProvider(value) { provider = value; return () => {} },
      getProvider() { return provider },
      async start(_name, request) { return provider.start(request) },
      async startContinuable(spec) {
        continuable.push(spec)
        await provider.prepareContinuable({ sessionId: spec.childId, parent: spec.request.parent, signal: spec.signal })
        return { childId: spec.childId, messageId: 'message-' + continuable.length }
      },
    },
    subprocess: {
      async resolveExecutable() { return join(dir, 'agy.exe') },
      spawn(spec) {
        if (spec.argv[1] === 'help') return collectedHandle(options.help ?? HELP)
        if (options.streamMock && spec.argv.includes('--input-format')) {
          // Real child process: the mock speaks the documented streaming protocol over stdin/stdout.
          const handle = nodeSubprocess.spawn({ ...spec, argv: [process.execPath, MOCK_STREAM, ...spec.argv.slice(1)], env: {} })
          streamSpawns.push({ spec, handle })
          return handle
        }
        if (spec.argv[1] === 'models') {
          modelCalls.push(spec)
          const models = options.models ?? MODELS
          return typeof models === 'string' ? collectedHandle(models) : collectedHandle('', 1, models.fail)
        }
        const plan = plans.shift()
        if (!plan) throw new Error('unexpected agy spawn')
        const handle = scriptedHandle(spec, plan)
        spawns.push({ spec, handle })
        return handle
      },
    },
    llm: { registerAdapter(_routes, value) { adapter = value; return () => {} } },
    agents: { get(id) { return agents.get(id) } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
    logger: { info() {}, warn() {} },
    get(name) { return name === 'attachments' ? options.attachments : name === 'skills' ? options.skills : undefined },
  }
  const config = Config({
    evidenceDir: join(dir, 'evidence'), registryPath: join(dir, 'registry.json'),
    nativeRegistryPath: join(dir, 'native.json'), traceDir: join(dir, 'traces'), ...extraConfig,
  })
  apply(ctx, config)
  return { ctx, tools, spawns, agents, config, continuable, modelCalls, streamSpawns, get provider() { return provider }, get adapter() { return adapter } }
}

export const parentAgent = (dir, id = 'session-parent') => ({ id, session: { id, header: { cwd: dir } } })
