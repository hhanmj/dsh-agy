#!/usr/bin/env node
/**
 * OPT-IN live check of persistent AGY sessions through the BUILT plugin
 * (spends a little AGY quota):  node scripts/live-persistent-e2e.mjs
 * A main session with nativePersistentSessions on runs several turns on one
 * agy process (tool turn included), is cancelled mid-turn, resumes on a new
 * process with --conversation, and its warm-turn latency is compared with the
 * one-shot path (medians). Node subprocess shim, not the DSH runtime.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { apply, Config } = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href)
const { subprocess } = await import(pathToFileURL(join(ROOT, 'scripts/helpers/node-subprocess.mjs')).href)
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2 }

function plugin(persistent) {
  const ws = mkdtempSync(join(tmpdir(), 'agy-pe2e-ws-'))
  const state = mkdtempSync(join(tmpdir(), 'agy-pe2e-state-'))
  const tools = new Map()
  let provider
  let adapter
  const session = 'live-persist-' + (persistent ? 'on' : 'off') + '-' + Date.now().toString(36)
  const agents = new Map([[session, { id: session, session: { id: session, header: { cwd: ws } } }]])
  const ctx = {
    effect(fn) { return fn() },
    subagents: { registerProvider(p) { provider = p; return () => {} }, getProvider() { return provider } },
    subprocess,
    llm: { registerAdapter(_r, value) { adapter = value; return () => {} } },
    agents: { get(id) { return agents.get(id) } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
    logger: { info() {}, warn: (m) => console.warn('[plugin:warn]', m) },
    get() { return undefined },
  }
  apply(ctx, Config({
    nativeContinuableEnabled: true, nativePersistentSessions: persistent,
    evidenceDir: join(state, 'evidence'), registryPath: join(state, 'registry.json'), nativeRegistryPath: join(state, 'native.json'), traceDir: join(state, 'traces'),
  }))
  return { ws, state, tools, session, get provider() { return provider }, get adapter() { return adapter } }
}

async function ask(p, text, signal) {
  const started = performance.now()
  const deltas = []
  let final = ''
  let usage
  for await (const c of p.adapter.stream({ provider: 'agy-native-cli', model: 'gemini-3.8-flash', reasoningEffort: 'low', sessionId: p.session, messages: [{ role: 'user', content: [{ type: 'text', text }] }], ...(signal ? { signal } : {}) })) {
    if (c.type === 'text-delta') deltas.push(c.text)
    if (c.type === 'block-end') final = c.block.text
    if (c.type === 'usage') usage = c.usage
  }
  return { ms: performance.now() - started, final, streamed: deltas.join(''), usage }
}

let failures = 0
const ok = (c, l) => { console.log((c ? '  PASS  ' : '  FAIL  ') + l); if (!c) failures += 1 }
const on = plugin(true)
const off = plugin(false)
try {
  const t1 = await ask(on, 'Reply with exactly the single word: one. Do not use any tools.')
  const t2 = await ask(on, 'Run the shell command: echo persistent-ok . Then reply with exactly its output.')
  const t3 = await ask(on, 'Reply with exactly the single word: three. Do not use any tools.')
  const warm = [t3.ms]
  for (const w of ['four', 'five']) warm.push((await ask(on, 'Reply with exactly the single word: ' + w + '.')).ms)
  console.log('turn1', Math.round(t1.ms), JSON.stringify(t1.final.slice(0, 40)), JSON.stringify(t1.usage))
  console.log('turn2', Math.round(t2.ms), JSON.stringify(t2.streamed.slice(0, 200)))
  console.log('turn3', Math.round(t3.ms), JSON.stringify(t3.final.slice(0, 40)), JSON.stringify(t3.usage))
  ok(/one/i.test(t1.final) && /three/i.test(t3.final), 'answers belong to their own turns')
  ok(/AGY · run_command echo persistent-ok — running/.test(t2.streamed) && /AGY · run_command echo persistent-ok — done/.test(t2.streamed), 'live start and finish lines for the tool step')
  ok(/persistent-ok/.test(t2.final) && /dsh-ui/.test(t2.final) && !/> AGY ·/.test(t2.final), 'settled turn: AGY text + one execution panel, no progress lines')
  ok(t3.usage.outputTokens < 50, 'per-turn output tokens (not cumulative): ' + t3.usage.outputTokens)
  const trace = await on.tools.get('antigravity_trace').execute({ id: on.session, limit: 200 }, { agent: { id: on.session } })
  const starts = trace.events.filter((e) => e.type === 'run_start')
  ok(new Set(starts.map((s) => s.process?.pid)).size === 1 && starts.length === 5, 'five turns on one agy process (pid ' + starts[0]?.process?.pid + ')')
  // cancel mid-turn
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 2500)
  let threw = false
  try { await ask(on, 'Write the numbers from 1 to 400, one per line, with no other text.', controller.signal) } catch { threw = true }
  const recall = await ask(on, 'What single word did I ask you to reply with in my very first message? Reply with that word only.')
  const after = await on.tools.get('antigravity_trace').execute({ id: on.session, limit: 200 }, { agent: { id: on.session } })
  const ends = after.events.filter((e) => e.type === 'run_end').map((e) => e.outcome)
  const lastStart = after.events.filter((e) => e.type === 'run_start').at(-1)
  ok(threw && ends.at(-2) === 'cancelled', 'stop mid-turn reports cancelled, never success')
  ok(/one/i.test(recall.final) && lastStart.process.reused === false && lastStart.process.pid !== starts[0].process.pid, 'next turn: new process resumed the conversation (' + JSON.stringify(recall.final.trim()) + ')')
  // one-shot comparison on the same kind of turns
  const cold = []
  await ask(off, 'Reply with exactly the single word: one.')
  for (const w of ['two', 'three', 'four']) cold.push((await ask(off, 'Reply with exactly the single word: ' + w + '.')).ms)
  console.log('warm persistent turns ms: ' + warm.map(Math.round).join(', ') + ' median ' + Math.round(median(warm)))
  console.log('one-shot resumed turns ms: ' + cold.map(Math.round).join(', ') + ' median ' + Math.round(median(cold)))
} finally {
  await on.provider.disposePersistent()
  for (const p of [on, off]) { rmSync(p.ws, { recursive: true, force: true }); rmSync(p.state, { recursive: true, force: true }) }
}
console.log(failures === 0 ? '\nLIVE PERSISTENT E2E: all checks passed' : '\nLIVE PERSISTENT E2E: ' + failures + ' check(s) failed')
process.exit(failures === 0 ? 0 : 1)
