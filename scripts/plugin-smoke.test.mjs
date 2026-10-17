import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../lib/index.js'
import { captureWorkspace, collectEvidence, saveEvidence } from '../lib/evidence.js'

test('Cordis-compatible registration and review tool return machine-readable evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-plugin-smoke-'))
  try {
    const tools = new Map()
    let provider
    const ctx = {
      effect(register) { return register() },
      subagents: {
        registerProvider(p) { provider = p; return () => {} },
        getProvider() { return provider },
      },
      tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
      logger: { info() {}, warn() {} },
      get() { return undefined },
    }
    const config = Config({ evidenceDir: join(dir, 'evidence') })
    apply(ctx, config)
    assert.equal(provider.name, 'antigravity')
    for (const name of ['antigravity', 'antigravity_followup', 'antigravity_evidence', 'antigravity_cancel', 'antigravity_tasks']) {
      assert.ok(tools.has(name), `missing registered tool: ${name}`)
    }
    const before = captureWorkspace(dir)
    const report = collectEvidence(before, 'plugin-test', 'failed', null, 'simulated error')
    saveEvidence(report, config.evidenceDir)
    const result = await tools.get('antigravity_evidence').execute({ task: 'plugin-test' }, {})
    assert.equal(result.evidence.task_id, 'plugin-test')
    assert.equal(result.evidence.execution_status, 'failed')
    assert.equal(result.evidence.review_status, 'pending')
    const rendered = tools.get('antigravity_evidence').output.render({}, result)
    assert.ok(JSON.stringify(rendered).includes('simulated error'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('DSH Jobs 0.2 background owner is SessionId and progress uses byte-offset output source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-bg-contract-'))
  try {
    const tools = new Map()
    let provider
    let jobSpec
    const jobs = {
      start(spec) {
        jobSpec = spec
        return 'antigravity-1'
      },
    }
    const lifecycle = []
    const ctx = {
      effect(register) { return register() },
      subagents: {
        registerProvider(value) { provider = value; return () => {} },
        getProvider() { return provider },
        async start(name, request) {
          assert.equal(name, 'antigravity')
          const run = await provider.start(request)
          lifecycle.push('subagent/start')
          void run.result.then(() => lifecycle.push('subagent/end'))
          return run
        },
      },
      tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
      logger: { info() {}, warn() {} },
      get(service) { return service === 'jobs' ? jobs : undefined },
    }
    apply(ctx, Config({ evidenceDir: join(dir, 'evidence') }))
    const parts = ['界面更新\\n', 'PONG2\\n', '[task: test-task]']
    let finish
    const done = new Promise((resolve) => { finish = resolve })
    provider.startBackground = async () => ({
      id: 'session-live-0123::agy::bg-1',
      cancel() {},
      done,
      readOutput: () => parts.shift() ?? '',
    })
    const parent = { id: 'session-live-0123', session: { header: { cwd: dir } } }
    const response = await tools.get('antigravity').execute(
      { description: 'Background contract test', prompt: 'PONG', cwd: dir, background: true },
      { agent: parent, signal: new AbortController().signal },
    )
    assert.equal(response.jobId, 'antigravity-1')
    assert.equal(jobSpec.owner, parent.id)
    assert.equal(typeof jobSpec.owner, 'string')
    assert.ok(Array.isArray(jobSpec.output))
    assert.equal(jobSpec.output.length, 1)
    const source = jobSpec.output[0]
    const first = source.read(0)
    assert.equal(first.text, '界面更新\\n')
    assert.equal(first.nextOffset, Buffer.byteLength(first.text))
    const replay = source.read(0)
    assert.equal(replay.text, '界面更新\\nPONG2\\n')
    const last = source.read(replay.nextOffset)
    assert.equal(last.text, '[task: test-task]')
    assert.equal(last.nextOffset, Buffer.byteLength(replay.text + last.text))
    const noop = source.read(last.nextOffset)
    assert.equal(noop.text, '')
    finish({ status: 'completed', detail: 'completed' })
    assert.deepEqual(await jobSpec.run().done, { status: 'completed', detail: 'completed' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(lifecycle, ['subagent/start', 'subagent/end'])
    assert.equal(response.task, 'session-live-0123::agy::bg-1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

