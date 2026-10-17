import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config, hasAgyBackground } from '../lib/index.js'

test('antigravity foreground and followup both pass through ctx.subagents.start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-native-route-'))
  try {
    const tools = new Map()
    let provider
    const requests = []
    const ctx = {
      effect(register) { return register() },
      subagents: {
        registerProvider(value) { provider = value; return () => {} },
        getProvider() { return provider },
        async start(name, request) {
          assert.equal(name, 'antigravity')
          requests.push(request)
          const n = requests.length
          return {
            id: 'session-native::agy::run-' + n,
            localAgent: undefined,
            result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: n === 1 ? 'PONG' : 'PONG2' }] }),
            async dispose() {},
          }
        },
      },
      tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
      logger: { info() {}, warn() {} },
      get() { return undefined },
    }
    const config = Config({ evidenceDir: join(dir, 'evidence'), registryPath: join(dir, 'registry.json') })
    apply(ctx, config)
    provider.recordOf = () => ({
      conversationId: 'agy-conversation-123',
      cwd: dir,
      label: 'Native routing test',
      createdAt: Date.now(),
    })
    const parent = { id: 'session-native', session: { header: { cwd: dir } } }
    const exec = { agent: parent, signal: new AbortController().signal }
    const first = await tools.get('antigravity').execute({
      description: 'Native foreground', prompt: 'PONG', cwd: dir, model: 'Gemini 3.1 Pro', effort: 'high', background: false,
    }, exec)
    assert.equal(first.runId, 'session-native::agy::run-1')
    assert.equal(first.evidence.execution_status, 'completed')
    assert.equal(first.evidence.review_status, 'pending')
    assert.equal(requests[0].parent, parent)
    assert.equal(requests[0].agyOptions.cwd, dir)
    assert.equal(requests[0].agyOptions.model, 'Gemini 3.1 Pro')
    assert.equal(requests[0].agyOptions.effort, 'high')
    const second = await tools.get('antigravity_followup').execute({
      description: 'Native followup', task: first.task, prompt: 'PONG2',
    }, exec)
    assert.equal(second.task, first.task)
    assert.equal(second.runId, 'session-native::agy::run-2')
    assert.equal(second.evidence.execution_status, 'completed')
    assert.equal(requests[1].agyOptions.conversationId, 'agy-conversation-123')
    assert.equal(requests[1].agyOptions.cwd, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native provider background returns one remote SubagentRun with job streaming, status and cancellation hooks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-native-back-'))
  try {
    const tools = new Map()
    let provider
    const ctx = {
      effect(register) { return register() },
      subagents: {
        registerProvider(value) { provider = value; return () => {} },
        getProvider() { return provider },
      },
      tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
      logger: { info() {}, warn() {} },
      get() { return undefined },
    }
    apply(ctx, Config({ evidenceDir: join(dir, 'evidence') }))
    const responses = ['progress: reading files\\n', 'result: complete\\n']
    let complete
    const done = new Promise((resolve) => { complete = resolve })
    let cancelCount = 0
    provider.startBackground = async (request, dirs, opts) => {
      assert.deepEqual(dirs, [dir])
      assert.equal(opts.cwd, dir)
      return {
        id: 'session-parent::agy::bg-1',
        cancel() { cancelCount++ },
        done,
        readOutput: () => responses.shift() ?? '',
      }
    }
    const parent = { id: 'session-parent', session: { header: { cwd: dir } } }
    const request = {
      parent, label: 'Native background', prompt: [{ type: 'text', text: 'PING' }],
      signal: new AbortController().signal,
      agyOptions: { background: true, cwd: dir, dirs: [dir] },
    }
    const run = await provider.start(request)
    assert.equal(run.id, 'session-parent::agy::bg-1')
    assert.equal(run.localAgent, undefined)
    assert.equal(hasAgyBackground(run), true)
    const first = run.agyBackground.output.read(0)
    assert.equal(first.text, 'progress: reading files\\n')
    const second = run.agyBackground.output.read(first.nextOffset)
    assert.equal(second.text, 'result: complete\\n')
    complete({ status: 'completed', detail: 'completed' })
    const result = await run.result
    assert.equal(result.stopReason, 'completed')
    assert.match(result.output[0].text, /progress: reading files/)
    assert.match(result.output[0].text, /result: complete/)
    await run.dispose()
    assert.equal(cancelCount, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native provider reports failed background status to subagent manager', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-native-fail-'))
  try {
    let provider
    const ctx = {
      effect(fn) { return fn() },
      subagents: { registerProvider(p) { provider = p; return () => {} } },
      tools: { register() { return () => {} } },
      logger: { info() {}, warn() {} },
      get() { return undefined },
    }
    apply(ctx, Config({ evidenceDir: join(dir, 'evidence') }))
    provider.startBackground = async () => ({
      id: 'session-p::agy::fail-1',
      cancel() {},
      done: Promise.resolve({ status: 'failed', detail: 'transport failure' }),
      readOutput: () => 'transport failure',
    })
    const run = await provider.start({
      parent: { id: 'session-p' }, label: 'Failing background',
      prompt: [{ type: 'text', text: 'test' }], signal: new AbortController().signal,
      agyOptions: { background: true },
    })
    const result = await run.result
    assert.equal(result.stopReason, 'error')
    assert.match(result.diagnostic, /transport failure/)
    await run.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
