import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluatePreToolUse } from '../lib/supervisor-hook.js'
import { defaultProtectedPaths } from '../lib/supervision.js'
import { harness, parentAgent } from './helpers/fake-agy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PONG = readFileSync(join(ROOT, 'scripts', 'fixtures', 'agy-1.4.0-pong.ndjson'), 'utf8')
const flags = (argv, name) => argv.flatMap((value, i) => (value === name ? [argv[i + 1]] : []))

function skill(root, folder, name) {
  const dir = join(root, folder)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: ' + name + '\ndescription: test skill ' + name + '\n---\n\nbody\n')
  return join(dir, 'SKILL.md')
}

test('sharedSkills: selected DSH skills reach AGY through a reused skills.json bridge (no copies, no links)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'agy-skills-'))
  try {
    const ws = join(base, 'ws')
    mkdirSync(ws)
    const listed = [
      { name: 'alpha', path: skill(join(base, 'skills-a'), 'alpha', 'alpha'), invocation: { modelInvocable: true } },
      { name: 'beta', path: skill(join(base, 'skills-a'), 'beta', 'beta'), invocation: { modelInvocable: false } },
      { name: 'gamma-one', path: skill(join(base, 'skills-b'), 'gamma-dir', 'gamma-one'), invocation: { modelInvocable: true } },
      { name: 'virtual', invocation: { modelInvocable: true } },
    ]
    const calls = []
    const skills = { async list(options) { calls.push(options); return listed } }
    const h = harness(base, [{ chunks: [Buffer.from(PONG)] }, { chunks: [Buffer.from(PONG)] }],
      { sharedSkills: ['alpha', 'beta', 'gamma*', 'virtual'], sharedSkillsDir: join(base, 'bridges') }, { skills })
    const run = async () => {
      const r = await h.provider.startWithDirs({ label: 'skills', parent: parentAgent(ws), prompt: [{ type: 'text', text: 'go' }], signal: new AbortController().signal }, [], { cwd: ws })
      await r.result
      await r.dispose()
      return r
    }
    const first = await run()
    await run()
    const dirs = h.spawns.map((s) => flags(s.spec.argv, '--add-dir'))
    assert.equal(dirs[0].length, 1)
    assert.equal(dirs[0][0], dirs[1][0], 'bridge is content-addressed and reused')
    assert.ok(dirs[0][0].startsWith(join(base, 'bridges')))
    const manifest = JSON.parse(readFileSync(join(dirs[0][0], '.agents', 'skills.json'), 'utf8'))
    assert.deepEqual(manifest, { entries: [
      { path: join(base, 'skills-a').replace(/\\/g, '/'), include_only: ['alpha'] },
      { path: join(base, 'skills-b').replace(/\\/g, '/'), include_only: ['gamma-dir'] },
    ] })
    assert.equal(calls[0].cwd, ws)
    const trace = await h.tools.get('antigravity_trace').execute({ id: first.id }, { agent: parentAgent(ws) })
    assert.deepEqual(trace.events.find((e) => e.type === 'run_start').shared_skills, ['alpha', 'gamma-one'])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('sharedSkills off or unmatched adds no bridge directory', async () => {
  const base = mkdtempSync(join(tmpdir(), 'agy-skills-off-'))
  try {
    const ws = join(base, 'ws')
    mkdirSync(ws)
    const h = harness(base, [{ chunks: [Buffer.from(PONG)] }, { chunks: [Buffer.from(PONG)] }], { sharedSkills: ['nothing-matches'], sharedSkillsDir: join(base, 'bridges') }, { skills: { async list() { return [] } } })
    const r = await h.provider.startWithDirs({ label: 'x', parent: parentAgent(ws), prompt: [{ type: 'text', text: 'go' }], signal: new AbortController().signal }, [], { cwd: ws })
    await r.result
    await r.dispose()
    assert.deepEqual(flags(h.spawns[0].spec.argv, '--add-dir'), [])
    assert.equal(existsSync(join(base, 'bridges')), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('supervision keeps shared skill folders readable (even under ~/.dsh) but never writable', () => {
  const home = join(tmpdir(), 'agy-home-probe')
  const skillDir = join(home, '.dsh', 'profiles', 'web', 'node_modules', 'pkg', 'skills', 'alpha')
  const policy = {
    version: 1, runId: 'r', roots: [join(tmpdir(), 'agy-ws-probe')], readRoots: [skillDir], protectedPaths: defaultProtectedPaths(home),
    supervisorDir: join(home, '.dsh', 'agy-supervisor', 'x'), home, builtinRules: true, denyCommands: [], logPath: 'l', statePath: 's',
  }
  const call = (name, args) => evaluatePreToolUse({ toolCall: { name, args } }, policy)
  assert.equal(call('view_file', { AbsolutePath: join(skillDir, 'SKILL.md') }).decision, 'allow')
  assert.equal(call('run_command', { CommandLine: 'python ' + join(skillDir, 'scripts', 'run.py') }).decision, 'allow')
  assert.equal(call('write_to_file', { TargetFile: join(skillDir, 'SKILL.md') }).decision, 'deny')
  assert.equal(call('view_file', { AbsolutePath: join(home, '.dsh', 'agy-native-sessions.json') }).rule, 'protected-path')
  assert.equal(call('run_command', { CommandLine: 'cat ~/.dsh/agy-native-sessions.json' }).rule, 'protected-path')
})
