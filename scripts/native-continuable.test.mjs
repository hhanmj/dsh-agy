import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../lib/index.js'
import { nativePrompt, NativeAgyLlmAdapter } from '../lib/native-bridge.js'

const request = (messages, extra = {}) => ({
  provider: 'agy-native-cli', model: 'agy-cli',
  messages, ...extra,
})

test('native prompt restores AGY conversation, strips host tool declarations and rejects unsupported input', () => {
  const first = nativePrompt(request([
    { role: 'system', content: [{ type: 'text', text: 'Safe system instructions' }] },
    { role: 'user', content: [{ type: 'text', text: 'Make UI interactive' }] },
  ]), false)
  assert.match(first, /Safe system instructions/)
  assert.match(first, /Make UI interactive/)
  assert.match(first, /cannot invoke DSH host tools/)
  const resumed = nativePrompt(request([
    { role: 'user', content: [{ type: 'text', text: 'old prompt' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
    { role: 'user', content: [{ type: 'text', text: 'fix keyboard focus' }] },
  ]), true)
  assert.equal(resumed, 'fix keyboard focus')
  assert.throws(() => nativePrompt(request([
    { role: 'user', content: [{ type: 'image', data: 'fake' }] },
  ]), false), /unsupported request block image/)
  const toolSchema = { name: 'secret_host_tool', description: 'HOST_ONLY_SCHEMA_SHOULD_NOT_LEAK', parameters: {} }
  const withGlobalAndScopedTools = nativePrompt(request([
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  ], { tools: [toolSchema] }), false)
  assert.match(withGlobalAndScopedTools, /hello/)
  assert.doesNotMatch(withGlobalAndScopedTools, /secret_host_tool|HOST_ONLY_SCHEMA_SHOULD_NOT_LEAK/)
  assert.throws(() => nativePrompt(request([
    { role: 'tool', content: [{ type: 'text', text: 'fabricated host tool response' }] },
  ]), false), /unsupported DSH message role tool/)
})

test('native LLM adapter streams text without inventing tools or usage', async () => {
  const seen = []
  const adapter = new NativeAgyLlmAdapter('agy-native-cli', async (options) => {
    seen.push(options)
    return 'AGY_NATIVE_OK'
  })
  assert.equal((await adapter.listModels('agy-native-cli'))[0].id, 'agy-cli')
  assert.deepEqual((await adapter.resolveModel('agy-native-cli', 'agy-cli')).inputModalities, ['text'])
  const chunks = []
  for await (const chunk of adapter.stream(request([
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
  ], { tools: [{ name: 'scoped_tool', description: 'NOT_FOR_CLI', parameters: {} }], toolHistory: [{ id: 'private-call', args: {} }] }))) chunks.push(chunk)
  assert.equal(chunks[1].text, 'AGY_NATIVE_OK')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
  assert.equal(chunks.some((c) => c.type === 'tool-call-delta' || c.type === 'usage'), false)
  assert.equal(seen.length, 1)
  assert.equal(Object.hasOwn(seen[0], 'tools'), false)
  assert.equal(Object.hasOwn(seen[0], 'toolHistory'), false)
})

test('native child start is real DSH startContinuable, no fabricated tree or local agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-native-con-'))
  try {
    let provider
    let adapter
    let startSpec
    const tools = new Map()
    const child = { id: 'session-native', session: { header: { cwd: dir } } }
    const ctx = {
      effect(fn) { return fn() },
      subagents: {
        registerProvider(value) { provider = value; return () => {} },
        async startContinuable(spec) {
          startSpec = spec
          await provider.prepareContinuable({ sessionId: spec.childId, parent: spec.request.parent, signal: spec.signal })
          return { childId: spec.childId, messageId: 'message-1' }
        },
      },
      llm: { registerAdapter(routes, value) {
        assert.deepEqual(routes, ['agy-native-cli'])
        adapter = value
        return () => {}
      } },
      agents: { get() { return child } },
      tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
      logger: { info() {}, warn() {} },
      get() { return undefined },
    }
    const registry = join(dir, 'agy-native-sessions.json')
    apply(ctx, Config({ evidenceDir: join(dir, 'evidence'), nativeRegistryPath: registry, nativeContinuableEnabled: true }))
    assert.ok(adapter)
    assert.ok(tools.has('antigravity_native_start'))
    const response = await tools.get('antigravity_native_start').execute(
      { description: 'Real child', prompt: 'fix interactive UI' },
      { agent: child, signal: new AbortController().signal },
    )
    assert.equal(response.state, 'accepted')
    assert.match(response.childId, /^[0-9a-f-]{36}$/i)
    assert.equal(startSpec.request.agentOptions.provider, 'agy-native-cli')
    assert.equal(startSpec.request.agentOptions.model, 'agy-cli')
    assert.deepEqual(startSpec.request.toolFilter, { allow: [] })
    assert.equal(startSpec.request.prompt[0].text, 'fix interactive UI')

    const firstRun = 'session-native::agy::transport-1'
    const secondRun = 'session-native::agy::transport-2'
    let invokedFirst, invokedFollowup
    provider.startWithDirs = async (req, dirs, opts) => {
      invokedFirst = { req, dirs, opts }
      return {
        id: firstRun,
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'first AGY answer' }] }),
        async dispose() {},
      }
    }
    provider.followup = async (req, conversationId, cwd) => {
      invokedFollowup = { req, conversationId, cwd }
      return {
        id: secondRun,
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'resumed AGY answer' }] }),
        async dispose() {},
      }
    }
    provider.recordOf = (runId) => ({
      conversationId: 'agy-conversation-123', cwd: dir, label: runId,
      createdAt: Date.now(),
    })
    const input = request([
      { role: 'user', content: [{ type: 'text', text: 'fix UI' }] },
    ], { sessionId: response.childId })
    let chunks = []
    for await (const chunk of adapter.stream(input)) chunks.push(chunk)
    assert.equal(chunks[1].text, 'first AGY answer')
    assert.equal(invokedFirst.opts.cwd, dir)
    assert.equal(invokedFirst.req.prompt[0].type, 'text')
    const stored = JSON.parse(readFileSync(registry, 'utf8'))
    assert.equal(stored[response.childId].conversationId, 'agy-conversation-123')
    chunks = []
    for await (const chunk of adapter.stream(request([
      { role: 'user', content: [{ type: 'text', text: 'fix UI' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'first AGY answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'fix focus next' }] },
    ], { sessionId: response.childId }))) chunks.push(chunk)
    assert.equal(chunks[1].text, 'resumed AGY answer')
    assert.equal(invokedFollowup.conversationId, 'agy-conversation-123')
    assert.equal(invokedFollowup.cwd, dir)
    assert.equal(invokedFollowup.req.prompt[0].text.includes('fix focus next'), true)
    assert.equal(invokedFollowup.req.prompt[0].text.includes('first AGY answer'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native capability is off by default and never silently creates child', async () => {
  let provider
  const registered = []
  const ctx = {
    effect(fn) { return fn() },
    subagents: { registerProvider(p) { provider = p; return () => {} } },
    tools: { register(t) { registered.push(t.name); return () => {} } },
    logger: { info() {}, warn() {} },
    get() { return undefined },
  }
  apply(ctx, Config({}))
  assert.equal(registered.includes('antigravity_native_start'), false)
  await assert.rejects(provider.prepareContinuable(), /disabled/)
})