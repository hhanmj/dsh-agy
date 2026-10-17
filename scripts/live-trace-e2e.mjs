#!/usr/bin/env node
/**
 * OPT-IN live check (spends AGY quota; requires an agy login):
 *   node scripts/live-trace-e2e.mjs
 *
 * Drives the BUILT plugin (lib/) against the real Antigravity CLI in an
 * isolated temporary workspace and temporary state directory: two native
 * child turns through the NativeAgyLlmAdapter (first turn with tools, then a
 * --conversation follow-up), printing when each streamed text delta arrived,
 * the antigravity_trace rendering, and the linked local evidence.
 *
 * This exercises the plugin code paths with a minimal Node subprocess shim in
 * place of DSH's ctx.subprocess. It is NOT a substitute for verifying the
 * plugin inside a running DSH Desktop; nothing in ~/.dsh is modified.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { apply, Config } = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href)
const { subprocess } = await import(pathToFileURL(join(ROOT, 'scripts/helpers/node-subprocess.mjs')).href)

const workspace = mkdtempSync(join(tmpdir(), 'agy-live-ws-'))
const state = mkdtempSync(join(tmpdir(), 'agy-live-state-'))
const tools = new Map()
let provider
let adapter
const childId = '7a1e0000-0000-4000-8000-' + Date.now().toString(16).padStart(12, '0').slice(-12)
const parent = { id: 'live-parent' }
const child = { id: childId, session: { id: childId, header: { cwd: workspace } } }
const ctx = {
  effect(fn) { return fn() },
  subagents: { registerProvider(p) { provider = p; return () => {} }, getProvider() { return provider } },
  subprocess,
  llm: { registerAdapter(_routes, value) { adapter = value; return () => {} } },
  agents: { get(id) { return id === childId ? child : undefined } },
  tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
  logger: { info: (m) => console.log('[plugin]', m), warn: (m) => console.warn('[plugin:warn]', m) },
  get() { return undefined },
}
apply(ctx, Config({
  nativeContinuableEnabled: true,
  evidenceDir: join(state, 'evidence'), registryPath: join(state, 'registry.json'),
  nativeRegistryPath: join(state, 'native.json'), traceDir: join(state, 'traces'),
  printTimeoutMs: 240_000,
}))

async function turn(messages) {
  const t0 = Date.now()
  const arrivals = []
  let final = ''
  for await (const chunk of adapter.stream({ provider: 'agy-native-cli', model: 'agy-cli', sessionId: childId, messages })) {
    if (chunk.type === 'text-delta') arrivals.push({ ms: Date.now() - t0, text: chunk.text })
    if (chunk.type === 'block-end') final = chunk.block.text
  }
  return { ms: Date.now() - t0, arrivals, final }
}

let failures = 0
const check = (ok, label) => { console.log((ok ? '  PASS  ' : '  FAIL  ') + label); if (!ok) failures += 1 }

try {
  await provider.prepareContinuable({ sessionId: childId, parent, signal: new AbortController().signal })
  const firstPrompt = 'Work only inside the current directory. Before EACH tool call, first write one short visible sentence saying what you will do. Steps: (1) run the shell command: echo live-trace (2) create a file named hello.txt containing exactly: hi (3) try to view the file missing.txt, which does not exist (that failure is expected). Finally reply with one line starting with FINAL:'
  const first = await turn([{ role: 'user', content: [{ type: 'text', text: firstPrompt }] }])
  console.log('\n== turn 1: ' + first.arrivals.length + ' text deltas over ' + first.ms + ' ms ==')
  for (const a of first.arrivals) console.log('  +' + a.ms + 'ms ' + JSON.stringify(a.text))
  check(first.arrivals.length > 1, 'turn 1 streamed more than one delta')
  check(first.arrivals.length > 0 && first.arrivals[0].ms < first.ms - 500, 'first delta arrived well before the turn ended')
  check(first.arrivals.map((a) => a.text).join('') === first.final, 'streamed text equals final block (no double append)')
  check(existsSync(join(workspace, 'hello.txt')), 'hello.txt exists in the isolated workspace')

  const trace1 = await tools.get('antigravity_trace').execute({ id: childId, limit: 200 }, { agent: parent })
  console.log('\n' + tools.get('antigravity_trace').output.render({}, trace1)[0].text)
  check(trace1.summary.lifecycle.execution === 'completed', 'trace execution completed')
  check(trace1.summary.tools_used.run_command?.calls >= 1, 'trace recorded run_command')
  check(Object.values(trace1.summary.tools_used).some((t) => t.errors >= 1), 'trace recorded the expected tool error')
  check(trace1.summary.lifecycle.evidence === 'collected' || trace1.summary.lifecycle.evidence === 'incomplete', 'evidence linked: ' + trace1.summary.lifecycle.evidence)

  const second = await turn([
    { role: 'user', content: [{ type: 'text', text: firstPrompt }] },
    { role: 'assistant', content: [{ type: 'text', text: first.final }] },
    { role: 'user', content: [{ type: 'text', text: 'Reply with exactly PONG2. Do not use any tools.' }] },
  ])
  console.log('\n== turn 2: ' + JSON.stringify(second.final) + ' (' + second.ms + ' ms) ==')
  check(/PONG2/.test(second.final), 'follow-up turn answered PONG2')
  const trace2 = await tools.get('antigravity_trace').execute({ id: childId, cursor: trace1.next_cursor, limit: 200 }, { agent: parent })
  console.log(tools.get('antigravity_trace').output.render({}, trace2)[0].text)
  check(trace2.summary.runs === 2 && trace2.summary.current_run.mode === 'native-followup', 'second run recorded as native-followup')
  check(trace2.summary.conversation_ids.length === 1, 'both turns share one AGY conversation_id')
  const native = JSON.parse(readFileSync(join(state, 'native.json'), 'utf8'))
  check(native[childId]?.conversationId === trace2.summary.conversation_ids[0], 'native registry maps child -> conversation_id')
  let denied = false
  try { await tools.get('antigravity_trace').execute({ id: childId }, { agent: { id: 'intruder' } }) } catch { denied = true }
  check(denied, 'another agent cannot read the trace')
} finally {
  console.log('\nworkspace: ' + workspace + '\nstate: ' + state)
  if (!process.argv.includes('--keep')) {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  }
}
console.log(failures === 0 ? '\nLIVE TRACE E2E: all checks passed' : '\nLIVE TRACE E2E: ' + failures + ' check(s) failed')
process.exit(failures === 0 ? 0 : 1)
