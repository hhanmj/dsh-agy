#!/usr/bin/env node
/**
 * OPT-IN live check of DSH supervision (spends AGY quota; requires an agy login):
 *   node scripts/live-supervision-e2e.mjs [--keep]
 *
 * Runs the BUILT plugin with supervisionEnabled against the real Antigravity
 * CLI in throwaway directories: a custom deny rule must block one command, an
 * ordinary command must run, and a failing stop check must make AGY rework
 * until the check passes. Hooks are injected per run with --add-dir; nothing in
 * the workspace, ~/.dsh or the global agy configuration is modified.
 * Uses a minimal Node subprocess shim, not the DSH runtime.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { apply, Config } = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href)
const { subprocess } = await import(pathToFileURL(join(ROOT, 'scripts/helpers/node-subprocess.mjs')).href)

const workspace = mkdtempSync(join(tmpdir(), 'agy-sup-ws-'))
const state = mkdtempSync(join(tmpdir(), 'agy-sup-state-'))
const check = join(state, 'check.mjs')
writeFileSync(check, "import { existsSync } from 'node:fs'\nif (!existsSync('ok.txt')) { console.log('missing ok.txt: create a file named ok.txt in the workspace containing the text ok'); process.exit(1) }\n")
const tools = new Map()
let provider
const parent = { id: 'live-sup-parent', session: { id: 'live-sup-parent', header: { cwd: workspace } } }
const ctx = {
  effect(fn) { return fn() },
  subagents: { registerProvider(p) { provider = p; return () => {} }, getProvider() { return provider } },
  subprocess,
  tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
  logger: { info: (m) => console.log('[plugin]', m), warn: (m) => console.warn('[plugin:warn]', m) },
  get() { return undefined },
}
apply(ctx, Config({
  evidenceDir: join(state, 'evidence'), registryPath: join(state, 'registry.json'), traceDir: join(state, 'traces'),
  supervisionEnabled: true, supervisionDir: join(state, 'supervisors'),
  supervisionDenyCommands: ['DSH_FORBIDDEN'],
  supervisionStopCheck: 'node ' + check, supervisionMaxReworks: 2,
  printTimeoutMs: 240_000,
}))

let failures = 0
const ok = (cond, label) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + label); if (!cond) failures += 1 }
try {
  const deltas = []
  const run = await provider.startWithDirs({
    label: 'live supervision', parent, signal: new AbortController().signal,
    prompt: [{ type: 'text', text: 'Work only inside the current directory. Run these shell commands one at a time: (1) echo DSH_FORBIDDEN-1 (2) echo allowed-2. If a command is blocked, do NOT retry it in any other way. Then reply with one line starting with FINAL:. If you are later asked to fix something before finishing, do exactly what is asked.' }],
  }, [], { cwd: workspace, stream: { onText: (d) => deltas.push(d) } })
  const result = await run.result
  await run.dispose()
  console.log('\nresult:', result.stopReason, JSON.stringify(result.output.map((b) => b.text).join('')).slice(0, 400))
  const trace = await tools.get('antigravity_trace').execute({ id: run.id, limit: 200 }, { agent: parent })
  console.log('\n' + tools.get('antigravity_trace').output.render({}, trace)[0].text + '\n')
  const sup = trace.summary.current_run.supervision
  ok(result.stopReason === 'completed', 'run completed')
  ok(trace.events.some((e) => e.type === 'tool_result' && e.state === 'ERROR' && /denied by pre-tool hook: DSH supervision blocked this tool call \(custom-deny\)/.test(e.error ?? '')), 'custom deny blocked echo DSH_FORBIDDEN-1 (stream tool error)')
  ok(trace.events.some((e) => e.type === 'tool_result' && e.state === 'DONE' && /allowed-2/.test(e.output_preview ?? '')), 'ordinary command ran')
  ok(typeof sup === 'object' && sup.denied >= 1, 'supervision report counts the denial')
  ok(typeof sup === 'object' && sup.reworks >= 1, 'failing stop check triggered rework')
  ok(existsSync(join(workspace, 'ok.txt')), 'AGY reworked: ok.txt now exists')
  ok(trace.events.some((e) => e.type === 'supervision' && e.event === 'Stop' && e.rule === 'stop-check-passed'), 'final stop check passed')
  ok(typeof sup === 'object' && Array.isArray(sup.tampered) && sup.tampered.length === 0, 'no supervisor tampering')
  ok(readdirSync(join(state, 'supervisors')).length === 0, 'per-run supervisor files removed')
  ok(!existsSync(join(workspace, '.agents')), 'nothing written into the workspace .agents')
} finally {
  console.log('workspace: ' + workspace + '\nstate: ' + state)
  if (!process.argv.includes('--keep')) {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  }
}
console.log(failures === 0 ? '\nLIVE SUPERVISION E2E: all checks passed' : '\nLIVE SUPERVISION E2E: ' + failures + ' check(s) failed')
process.exit(failures === 0 ? 0 : 1)
