#!/usr/bin/env node
/**
 * Phase 0 probe (v0.5.0 persistent CLI): exercises the documented streaming
 * protocol against the MOCK CLI (scripts/helpers/mock-agy-stream.mjs) through
 * the same subprocess seam shape DSH provides (stdin 'pipe', stdout stream).
 * No account, no network.   node scripts/phase0-persistent-probe.mjs
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { subprocess } = await import(pathToFileURL(join(ROOT, 'scripts/helpers/node-subprocess.mjs')).href)
const { NdjsonLineSplitter, parseAgyStreamLine } = await import(pathToFileURL(join(ROOT, 'lib/stream-events.js')).href)
const MOCK = join(ROOT, 'scripts', 'helpers', 'mock-agy-stream.mjs')

/** Minimal persistent session: one process, one turn at a time, result-delimited turns. */
class ProbeSession {
  constructor(extra = []) {
    this.handle = subprocess.spawn({
      argv: [process.execPath, MOCK, '--input-format', 'stream-json', '--output-format', 'stream-json', ...extra],
      cwd: ROOT, env: {}, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 65536 } },
    })
    this.splitter = new NdjsonLineSplitter()
    this.events = []
    this.waiters = []
    this.init = new Promise((resolve) => { this.resolveInit = resolve })
    this.previousUsage = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0 }
    this.handle.stdout.on('data', (chunk) => {
      for (const line of this.splitter.push(chunk)) {
        const event = parseAgyStreamLine(line)
        if (event === undefined) continue
        if (event.kind === 'init') this.resolveInit(event)
        this.events.push(event)
        for (const waiter of this.waiters.splice(0)) waiter()
      }
    })
    this.exit = this.handle.done
  }
  async next(predicate) {
    for (;;) {
      const index = this.events.findIndex(predicate)
      if (index >= 0) return this.events.splice(0, index + 1)
      const closed = await Promise.race([new Promise((resolve) => this.waiters.push(() => resolve(false))), this.exit.then(() => true)])
      if (closed && this.events.findIndex(predicate) < 0) return undefined
    }
  }
  async ask(content) {
    const started = performance.now()
    this.handle.stdin.write(JSON.stringify({ event: 'user', message: { content } }) + '\n')
    const turn = await this.next((event) => event.kind === 'result')
    if (turn === undefined) return { lost: true, ms: performance.now() - started }
    const result = turn.at(-1)
    const usage = result.usage ?? {}
    const delta = Object.fromEntries(Object.keys(this.previousUsage).map((key) => [key, (usage[key] ?? 0) - this.previousUsage[key]]))
    this.previousUsage = { ...this.previousUsage, ...Object.fromEntries(Object.keys(this.previousUsage).map((key) => [key, usage[key] ?? 0])) }
    const text = turn.filter((event) => event.kind === 'step' && event.textDelta).map((event) => event.textDelta).join('')
    const tools = turn.filter((event) => event.kind === 'step' && event.toolName).map((event) => event.toolName + ':' + event.state)
    return { status: result.status, response: result.response, text, turns: result.numTurns, delta, tools, conversation: result.conversationId, ms: performance.now() - started }
  }
}

let failures = 0
const ok = (cond, label) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + label); if (!cond) failures += 1 }

// 1. three turns, one process, one conversation; per-turn usage from cumulative counters
const a = new ProbeSession(['--model', 'gemini-3.8-flash'])
const init = await a.init
const t1 = await a.ask('one')
const t2 = await a.ask('tool:git status')
const t3 = await a.ask('three')
ok([t1, t2, t3].every((t) => t.status === 'SUCCESS' && t.conversation === init.conversationId), 'three turns on one process share one conversation_id')
ok(t1.turns === 1 && t3.turns === 3, 'num_turns is cumulative (1 → 3)')
ok(t3.delta.input_tokens === 300 && t3.delta.output_tokens === 10, 'per-turn usage = cumulative difference (turn 3 input 300, output 10)')
ok(t2.response === t2.text && t2.tools.join() === 'run_command:ACTIVE,run_command:DONE', 'turn response equals its own text deltas; tool ACTIVE/DONE observed')
// 2. unknown event skipped, turn-level ERROR keeps the session
a.handle.stdin.write(JSON.stringify({ event: 'future_thing' }) + '\n')
const failed = await a.ask('fail')
const after = await a.ask('still alive')
ok(failed.status === 'ERROR' && after.status === 'SUCCESS' && after.turns === 5, 'turn ERROR does not end the session; unknown events are skipped')
// 3. graceful close after in-flight turn
a.handle.stdin.write(JSON.stringify({ event: 'user', message: { content: 'last' } }) + '\n')
a.handle.stdin.end()
const lastTurn = await a.next((event) => event.kind === 'result')
const exitA = await a.exit
ok(lastTurn !== undefined && exitA.exitCode === 0, 'closing stdin delivers the in-flight result, then exits 0')

// 4. cancellation: terminate during a slow turn → no result, no success
const b = new ProbeSession()
await b.init
const pending = b.ask('slow:5000')
setTimeout(() => b.handle.terminate(), 200)
const cancelled = await pending
const exitB = await b.exit
ok(cancelled.lost === true && exitB.exitCode !== 0, 'terminating mid-turn yields no result and a non-zero exit (cannot be reported as success)')

// 5. invalid input ends the session with exit 1
const c = new ProbeSession()
await c.init
c.handle.stdin.write('{not json}\n')
const bad = await c.next((event) => event.kind === 'result')
const exitC = await c.exit
ok(bad?.at(-1)?.status === 'ERROR' && exitC.exitCode === 1, 'invalid JSON input: ERROR result, session ends with exit 1')

// 6. two concurrent sessions stay isolated
const d = new ProbeSession(); const e = new ProbeSession()
const [di, ei] = await Promise.all([d.init, e.init])
const [dr, er] = await Promise.all([d.ask('alpha'), e.ask('beta')])
ok(di.conversationId !== ei.conversationId && /alpha/.test(dr.response) && /beta/.test(er.response), 'concurrent sessions: separate processes and conversations, no cross-talk')
d.handle.stdin.end(); e.handle.stdin.end()
await Promise.all([d.exit, e.exit])

// 7. resume: a new process may start on a stored conversation id
const f = new ProbeSession(['--conversation', init.conversationId])
const fi = await f.init
ok(fi.conversationId === init.conversationId, 'a new persistent process can be started on a stored conversation_id (mock; real CLI must be verified)')
f.handle.stdin.end(); await f.exit

console.log(failures === 0 ? '\nPHASE 0 PROBE (mock): all checks passed' : '\nPHASE 0 PROBE (mock): ' + failures + ' check(s) failed')
process.exit(failures === 0 ? 0 : 1)
