#!/usr/bin/env node
/**
 * OPT-IN live check that AGY really uses a DSH skill shared via sharedSkills
 * (spends a little AGY quota):  node scripts/live-skills-e2e.mjs [--keep]
 * A temporary skill (stand-in for a DSH skill-registry entry) tells AGY to
 * answer with a marker; the run must load it through the skills.json bridge.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { apply, Config } = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href)
const { subprocess } = await import(pathToFileURL(join(ROOT, 'scripts/helpers/node-subprocess.mjs')).href)

const base = mkdtempSync(join(tmpdir(), 'agy-skills-live-'))
const workspace = join(base, 'ws')
mkdirSync(workspace)
const skillDir = join(base, 'dsh-skills', 'dsh-marker-skill')
mkdirSync(skillDir, { recursive: true })
writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: dsh-marker-skill\ndescription: Use this skill whenever the user asks for the DSH marker word.\n---\n\n# DSH marker skill\n\nThe DSH marker word is BLUE-HERON-42. When asked for the DSH marker word, reply with exactly that word and nothing else.\n')
const skills = { async list() { return [{ name: 'dsh-marker-skill', path: join(skillDir, 'SKILL.md'), invocation: { modelInvocable: true } }] } }
const tools = new Map()
let provider
const parent = { id: 'live-skills-parent', session: { id: 'live-skills-parent', header: { cwd: workspace } } }
const ctx = {
  effect(fn) { return fn() },
  subagents: { registerProvider(p) { provider = p; return () => {} }, getProvider() { return provider } },
  subprocess,
  tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
  logger: { info: (m) => console.log('[plugin]', m), warn: (m) => console.warn('[plugin:warn]', m) },
  get(name) { return name === 'skills' ? skills : undefined },
}
apply(ctx, Config({
  evidenceDir: join(base, 'evidence'), registryPath: join(base, 'registry.json'), traceDir: join(base, 'traces'),
  sharedSkills: ['dsh-marker-skill'], sharedSkillsDir: join(base, 'bridges'), printTimeoutMs: 180_000,
}))
let failures = 0
const ok = (cond, label) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + label); if (!cond) failures += 1 }
try {
  const run = await provider.startWithDirs({ label: 'skills live', parent, signal: new AbortController().signal,
    prompt: [{ type: 'text', text: 'What is the DSH marker word? Use your available skills to find out. Reply with the word only.' }] }, [], { cwd: workspace })
  const result = await run.result
  await run.dispose()
  const text = result.output.map((b) => b.text).join('')
  console.log('reply:', JSON.stringify(text))
  ok(/BLUE-HERON-42/.test(text), 'AGY answered from the shared DSH skill')
  const trace = await tools.get('antigravity_trace').execute({ id: run.id, limit: 100 }, { agent: parent })
  console.log(tools.get('antigravity_trace').output.render({}, trace)[0].text)
  ok(JSON.stringify(trace.events.find((e) => e.type === 'run_start').shared_skills) === '["dsh-marker-skill"]', 'trace records the shared skill')
} finally {
  if (!process.argv.includes('--keep')) rmSync(base, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nLIVE SKILLS E2E: all checks passed' : '\nLIVE SKILLS E2E: ' + failures + ' check(s) failed')
process.exit(failures === 0 ? 0 : 1)
