import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgyModelCatalog, defaultEffortFor, groupBaseModels, parseAgyModelsOutput, resolveSelection } from '../lib/models.js'
import { NativeAgyLlmAdapter } from '../lib/native-bridge.js'
import { MODELS, harness, parentAgent } from './helpers/fake-agy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PONG = readFileSync(join(ROOT, 'scripts', 'fixtures', 'agy-1.4.0-pong.ndjson'), 'utf8')
const flag = (argv, name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1] }
const pongRun = () => ({ chunks: [Buffer.from(PONG)] })

test('real "agy models" output groups effort variants into base models; CLI-default effort is high', () => {
  const models = groupBaseModels(parseAgyModelsOutput(MODELS + 'garbage line\n\tno id\n'))
  assert.deepEqual(models.map((m) => [m.id, m.efforts]), [
    ['gemini-3.8-flash', ['low', 'medium', 'high']],
    ['claude-sonnet-4-6', []],
    ['claude-opus-4-6-thinking', []],
    ['gpt-oss-120b', ['medium']],
  ])
  assert.equal(models[0].name, 'Gemini 3.8 Flash')
  assert.equal(defaultEffortFor(models[0]), 'high')
  assert.equal(defaultEffortFor(models[3]), 'medium')
  assert.equal(defaultEffortFor(models[1]), undefined)
})

test('selection mirrors agy 1.4.0 rules: base+effort, variant ids, no effort for variant-less models', () => {
  const models = groupBaseModels(parseAgyModelsOutput(MODELS))
  const args = (model, effort) => resolveSelection(models, model, effort).args
  assert.deepEqual(args('gemini-3.8-flash'), { model: 'gemini-3.8-flash', effort: 'high' })
  assert.deepEqual(args('gemini-3.8-flash', 'LOW'), { model: 'gemini-3.8-flash', effort: 'low' })
  assert.deepEqual(args('gemini-3.8-flash-medium'), { model: 'gemini-3.8-flash', effort: 'medium' })
  assert.deepEqual(args('gemini-3.8-flash-low', 'low'), { model: 'gemini-3.8-flash', effort: 'low' })
  assert.deepEqual(args('claude-sonnet-4-6'), { model: 'claude-sonnet-4-6' })
  assert.deepEqual(args('gpt-oss-120b-medium'), { model: 'gpt-oss-120b', effort: 'medium' })
  assert.throws(() => args('gemini-3.8-flash-low', 'high'), /conflicts with effort high/)
  assert.throws(() => args('claude-sonnet-4-6', 'high'), /no effort variants/)
  assert.throws(() => args('gemini-3.8-flash', 'max'), /supports efforts low \| medium \| high, not max/)
  assert.throws(() => args('gemini-3.8-flash', 'ultra'), /effort must be one of/)
  assert.throws(() => args('not-a-model; rm -rf /'), /unknown AGY model/)
})

test('catalog caches successes for the TTL and never caches failures or empty listings', async () => {
  let calls = 0
  let next = () => Promise.reject(new Error('agy offline'))
  const catalog = new AgyModelCatalog(() => { calls += 1; return next() }, 60_000)
  await assert.rejects(catalog.list(), /agy offline/)
  next = () => Promise.resolve('')
  await assert.rejects(catalog.list(), /no parseable/)
  next = () => Promise.resolve(MODELS)
  assert.equal((await catalog.list()).length, 4)
  await catalog.list()
  assert.equal(calls, 3)
  assert.equal(catalog.peek().length, 4)
})

test('native adapter lists only real models with efforts (agy-cli stays resolvable for legacy children)', async () => {
  const source = { list: async () => [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' }, { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)', efforts: [] }] }
  const adapter = new NativeAgyLlmAdapter('agy-native-cli', async () => '', source)
  assert.deepEqual((await adapter.listModels('agy-native-cli')).map((m) => m.id), ['gemini-3.8-flash', 'claude-sonnet-4-6'], 'agy-cli is no longer listed')
  const gemini = await adapter.resolveModel('agy-native-cli', 'gemini-3.8-flash')
  assert.deepEqual(gemini.reasoning.efforts.map((e) => e.id), ['low', 'medium', 'high'])
  assert.equal(gemini.reasoning.defaultEffort, 'high')
  assert.equal((await adapter.resolveModel('agy-native-cli', 'claude-sonnet-4-6')).reasoning, undefined)
  assert.equal((await adapter.resolveModel('agy-native-cli', 'agy-cli')).reasoning, undefined, 'legacy children keep resolving')
  await assert.rejects(adapter.resolveModel('agy-native-cli', 'gpt-9'), /does not list gpt-9/)
  const broken = new NativeAgyLlmAdapter('agy-native-cli', async () => '', { list: async () => { throw new Error('offline') } })
  assert.deepEqual((await broken.listModels('agy-native-cli')).map((m) => m.id), [])
})

function setup(prefix, plans, options) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const ws = join(dir, 'ws')
  mkdirSync(ws)
  const h = harness(dir, plans, { nativeContinuableEnabled: true }, options)
  return { dir, ws, h }
}

test('antigravity_native_start validates model/effort BEFORE creating the child and hands DSH the route to persist', async () => {
  const { dir, ws, h } = setup('agy-models-start-', [])
  try {
    const exec = { agent: parentAgent(ws), signal: new AbortController().signal }
    const start = (args) => h.tools.get('antigravity_native_start').execute({ description: 'x', prompt: 'go', ...args }, exec)
    const fast = await start({ model: 'gemini-3.8-flash', effort: 'low' })
    assert.deepEqual([fast.model, fast.effort, fast.model_source], ['gemini-3.8-flash', 'low', 'explicit'])
    assert.deepEqual(h.continuable.at(-1).request.agentOptions, { provider: 'agy-native-cli', model: 'gemini-3.8-flash', reasoningEffort: 'low' })
    const variant = await start({ model: 'gemini-3.8-flash-medium' })
    assert.equal(h.continuable.at(-1).request.agentOptions.reasoningEffort, 'medium')
    assert.equal(variant.effort, 'medium')
    const claude = await start({ model: 'claude-sonnet-4-6' })
    assert.deepEqual(h.continuable.at(-1).request.agentOptions, { provider: 'agy-native-cli', model: 'claude-sonnet-4-6' })
    assert.equal(claude.effort, undefined)
    const dflt = await start({})
    assert.deepEqual(h.continuable.at(-1).request.agentOptions, { provider: 'agy-native-cli', model: 'gemini-3.8-flash', reasoningEffort: 'high' })
    assert.deepEqual([dflt.model, dflt.effort, dflt.model_source], ['gemini-3.8-flash', 'high', 'plugin-default'])
    const legacy = await start({ model: 'agy-cli' })
    assert.deepEqual(h.continuable.at(-1).request.agentOptions, { provider: 'agy-native-cli', model: 'agy-cli' })
    assert.equal(legacy.model_source, 'cli-default')
    const rendered = h.tools.get('antigravity_native_start').output.render({}, fast)[0].text
    assert.match(rendered, /Requested AGY model: gemini-3\.8-flash \(effort low\)/)
    const before = h.continuable.length
    await assert.rejects(start({ model: 'nope' }), /unknown AGY model "nope"/)
    await assert.rejects(start({ effort: 'high' }), /effort requires an explicit model/)
    await assert.rejects(start({ model: 'agy-cli', effort: 'high' }), /effort requires an explicit model/)
    await assert.rejects(start({ model: 'claude-sonnet-4-6', effort: 'high' }), /no effort variants/)
    assert.equal(h.continuable.length, before, 'no child is created for an invalid route')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('model listing failure: explicit model is refused at creation, the default route still starts unvalidated', async () => {
  const { dir, ws, h } = setup('agy-models-fail-', [], { models: { fail: 'not logged in' } })
  try {
    const exec = { agent: parentAgent(ws), signal: new AbortController().signal }
    const start = (args) => h.tools.get('antigravity_native_start').execute({ description: 'x', prompt: 'go', ...args }, exec)
    await assert.rejects(start({ model: 'gemini-3.8-flash' }), /cannot verify AGY model "gemini-3\.8-flash": "agy models" exited with code 1: not logged in/)
    const fallback = await start({})
    assert.deepEqual([fallback.model, fallback.effort, fallback.model_source], ['gemini-3.8-flash', 'high', 'plugin-default'], 'default stays usable (agy validates it) when the listing fails')
    await assert.rejects(h.tools.get('antigravity_models').execute({}), /could not list AGY models/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('two native children keep separate routes; every turn (including resumed ones) re-sends --model/--effort', async () => {
  const { dir, ws, h } = setup('agy-models-children-', [pongRun(), pongRun(), pongRun(), pongRun(), pongRun()])
  try {
    const turn = async (childId, model, reasoningEffort, text) => {
      const chunks = []
      for await (const chunk of h.adapter.stream({
        provider: 'agy-native-cli', model, ...(reasoningEffort ? { reasoningEffort } : {}), sessionId: childId,
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      })) chunks.push(chunk)
      return chunks.find((c) => c.type === 'block-end').block.text
    }
    const children = { fast: 'aaaaaaaa-0000-4000-8000-000000000001', claude: 'aaaaaaaa-0000-4000-8000-000000000002', dflt: 'aaaaaaaa-0000-4000-8000-000000000003' }
    for (const id of Object.values(children)) {
      h.agents.set(id, { id, session: { id, header: { cwd: ws, origin: 'subagent' } } })
      await h.provider.prepareContinuable({ sessionId: id, parent: { id: 'session-parent' } })
    }
    assert.equal(await turn(children.fast, 'gemini-3.8-flash', 'low', 'one'), 'PONG\n')
    assert.equal(await turn(children.claude, 'claude-sonnet-4-6', undefined, 'one'), 'PONG\n')
    assert.equal(await turn(children.dflt, 'agy-cli', undefined, 'one'), 'PONG\n')
    await turn(children.fast, 'gemini-3.8-flash', 'low', 'two')
    await turn(children.claude, 'claude-sonnet-4-6', undefined, 'two')
    const argvs = h.spawns.map((s) => s.spec.argv)
    assert.deepEqual([flag(argvs[0], '--model'), flag(argvs[0], '--effort')], ['gemini-3.8-flash', 'low'])
    assert.deepEqual([flag(argvs[1], '--model'), argvs[1].includes('--effort')], ['claude-sonnet-4-6', false])
    assert.deepEqual([argvs[2].includes('--model'), argvs[2].includes('--effort')], [false, false], 'agy-cli keeps the CLI default')
    assert.ok(flag(argvs[3], '--conversation'), 'second turn resumes the AGY conversation')
    assert.deepEqual([flag(argvs[3], '--model'), flag(argvs[3], '--effort')], ['gemini-3.8-flash', 'low'], 'resume re-sends the route')
    assert.deepEqual([flag(argvs[4], '--model'), argvs[4].includes('--effort')], ['claude-sonnet-4-6', false])
    const trace = await h.tools.get('antigravity_trace').execute({ id: children.fast }, { agent: { id: 'session-parent' } })
    assert.deepEqual(trace.summary.current_run.model, { requested: 'gemini-3.8-flash', effort: 'low', source: 'explicit', effective: null, verified: false })
    assert.match(h.tools.get('antigravity_trace').output.render({}, trace)[0].text, /model=gemini-3\.8-flash effort=low/)
    assert.equal(h.modelCalls.length, 1, 'catalog listing is cached across turns')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('with nativeMainSessionEnabled off the native transport refuses non-child sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-models-guard-'))
  const ws = join(dir, 'ws')
  mkdirSync(ws)
  const h = harness(dir, [], { nativeContinuableEnabled: true, nativeMainSessionEnabled: false })
  try {
    h.agents.set('main-session', { id: 'main-session', session: { id: 'main-session', header: { cwd: ws } } })
    await assert.rejects(async () => {
      for await (const _ of h.adapter.stream({ provider: 'agy-native-cli', model: 'gemini-3.8-flash', sessionId: 'main-session', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) { /* drain */ }
    }, /only serves DSH child sessions .*nativeMainSessionEnabled is off/)
    assert.equal(h.spawns.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('task follow-ups keep the task model (agy would otherwise revert to its default); a new model drops the old effort', async () => {
  const { dir, ws, h } = setup('agy-models-followup-', [pongRun(), pongRun(), pongRun()])
  try {
    const exec = { agent: parentAgent(ws), signal: new AbortController().signal }
    const first = await h.tools.get('antigravity').execute({ description: 'task', prompt: 'go', cwd: ws, model: 'gemini-3.8-flash-low' }, exec)
    await h.tools.get('antigravity_followup').execute({ description: 'more', task: first.task, prompt: 'again' }, exec)
    await h.tools.get('antigravity_followup').execute({ description: 'switch', task: first.task, prompt: 'switch', model: 'claude-sonnet-4-6' }, exec)
    const argvs = h.spawns.map((s) => s.spec.argv)
    assert.deepEqual([flag(argvs[0], '--model'), flag(argvs[0], '--effort')], ['gemini-3.8-flash', 'low'])
    assert.deepEqual([flag(argvs[1], '--model'), flag(argvs[1], '--effort'), Boolean(flag(argvs[1], '--conversation'))], ['gemini-3.8-flash', 'low', true])
    assert.deepEqual([flag(argvs[2], '--model'), argvs[2].includes('--effort')], ['claude-sonnet-4-6', false])
    const registry = JSON.parse(readFileSync(join(dir, 'registry.json'), 'utf8'))
    assert.equal(registry[first.task].model, 'claude-sonnet-4-6')
    assert.equal(registry[first.task].effort, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('antigravity_models reports the real listing without inventing entries', async () => {
  const { dir, h } = setup('agy-models-tool-', [])
  try {
    const result = await h.tools.get('antigravity_models').execute({})
    assert.equal(result.default_model, 'agy-cli')
    assert.deepEqual(result.models.map((m) => m.id), ['gemini-3.8-flash', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b'])
    assert.deepEqual(result.models[0].cli_ids, ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low'])
    assert.equal(result.models[0].default_effort, 'high')
    const text = h.tools.get('antigravity_models').output.render({}, result)[0].text
    assert.match(text, /gemini-3\.8-flash — Gemini 3\.8 Flash; efforts: low \| medium \| high \(default high\)/)
    assert.match(text, /claude-sonnet-4-6 — Claude Sonnet 4\.6 \(Thinking\); no effort variants/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
