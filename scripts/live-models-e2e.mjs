#!/usr/bin/env node
/**
 * OPT-IN live check of per-child model selection (spends a little AGY quota):
 *   node scripts/live-models-e2e.mjs [--keep]
 *
 * Uses the BUILT plugin with the real Antigravity CLI in throwaway directories:
 * antigravity_models lists "agy models"; antigravity_native_start validates
 * three routes (explicit Claude, Gemini Flash low, CLI default); each child then
 * runs two turns (the second resumes the AGY conversation) exactly as DSH
 * would, re-using the agentOptions DSH persists for the child. Supervision is
 * on only so the Stop hook can report the model agy actually ran.
 * Uses a minimal Node subprocess shim, not the DSH runtime.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { apply, Config } = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href)
const { subprocess } = await import(pathToFileURL(join(ROOT, 'scripts/helpers/node-subprocess.mjs')).href)

const workspace = mkdtempSync(join(tmpdir(), 'agy-models-ws-'))
const state = mkdtempSync(join(tmpdir(), 'agy-models-state-'))
const tools = new Map()
const agents = new Map()
const specs = []
let provider
let adapter
const parent = { id: 'live-models-parent', session: { id: 'live-models-parent', header: { cwd: workspace } } }
const ctx = {
  effect(fn) { return fn() },
  subagents: {
    registerProvider(p) { provider = p; return () => {} },
    getProvider() { return provider },
    async startContinuable(spec) {
      specs.push(spec)
      await provider.prepareContinuable({ sessionId: spec.childId, parent: spec.request.parent, signal: spec.signal })
      agents.set(spec.childId, { id: spec.childId, session: { id: spec.childId, header: { cwd: workspace, origin: 'subagent' } } })
      return { childId: spec.childId, messageId: 'm' + specs.length }
    },
  },
  subprocess,
  llm: { registerAdapter(_routes, value) { adapter = value; return () => {} } },
  agents: { get(id) { return agents.get(id) } },
  tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
  logger: { info: (m) => console.log('[plugin]', m), warn: (m) => console.warn('[plugin:warn]', m) },
  get() { return undefined },
}
apply(ctx, Config({
  nativeContinuableEnabled: true, supervisionEnabled: true,
  evidenceDir: join(state, 'evidence'), registryPath: join(state, 'registry.json'), nativeRegistryPath: join(state, 'native.json'),
  traceDir: join(state, 'traces'), supervisionDir: join(state, 'supervisors'), printTimeoutMs: 180_000,
}))

let failures = 0
const ok = (cond, label) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + label); if (!cond) failures += 1 }

async function turn(childId, text) {
  const spec = specs.find((s) => s.childId === childId)
  const route = spec.request.agentOptions
  let final = ''
  for await (const chunk of adapter.stream({
    provider: route.provider, model: route.model, ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
    sessionId: childId, messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  })) if (chunk.type === 'block-end') final = chunk.block.text
  const trace = await tools.get('antigravity_trace').execute({ id: childId }, { agent: parent })
  return { final, model: trace.summary.current_run.model, mode: trace.summary.current_run.mode }
}

try {
  const listing = await tools.get('antigravity_models').execute({})
  console.log(tools.get('antigravity_models').output.render({}, listing)[0].text + '\n')
  ok(listing.models.some((m) => m.id === 'gemini-3.8-flash'), 'agy models lists gemini-3.8-flash')
  const start = (args) => tools.get('antigravity_native_start').execute({ description: 'models e2e', prompt: 'unused', ...args }, { agent: parent, signal: new AbortController().signal })
  const cases = [
    { name: 'claude', args: { model: 'claude-sonnet-4-6' }, expect: 'claude-sonnet-4-6' },
    { name: 'flash-low', args: { model: 'gemini-3.8-flash', effort: 'low' }, expect: 'gemini-3.8-flash-low' },
    { name: 'default', args: {}, expect: 'gemini-3.8-flash-high' },
  ]
  let rejected = false
  try { await start({ model: 'not-a-real-model' }) } catch { rejected = true }
  ok(rejected && specs.length === 0, 'unknown model refused before any child exists')
  for (const c of cases) c.child = (await start(c.args)).childId
  for (const c of cases) {
    const first = await turn(c.child, 'Reply with exactly the single word PONG. Do not use any tools.')
    const second = await turn(c.child, 'Reply with exactly the single word PONG2. Do not use any tools.')
    console.log(c.name, JSON.stringify({ first: first.model, second: second.model, replies: [first.final.trim(), second.final.trim()] }))
    ok(first.model.effective === c.expect, c.name + ': turn 1 effective model ' + first.model.effective + ' (expected ' + c.expect + ')')
    ok(second.mode === 'native-followup' && second.model.effective === c.expect, c.name + ': resumed turn kept ' + second.model.effective)
    ok(/PONG2/.test(second.final), c.name + ': resumed turn answered')
  }
} finally {
  console.log('workspace: ' + workspace + '\nstate: ' + state)
  if (!process.argv.includes('--keep')) {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  }
}
console.log(failures === 0 ? '\nLIVE MODELS E2E: all checks passed' : '\nLIVE MODELS E2E: ' + failures + ' check(s) failed')
process.exit(failures === 0 ? 0 : 1)
