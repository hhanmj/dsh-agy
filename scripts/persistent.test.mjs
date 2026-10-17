import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PersistentAgySessionManager } from '../lib/persistent.js'
import { subprocess as nodeSubprocess } from './helpers/node-subprocess.mjs'
import { HELP_STREAM, harness } from './helpers/fake-agy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOCK = join(ROOT, 'scripts', 'helpers', 'mock-agy-stream.mjs')
const spawn = (spec) => nodeSubprocess.spawn({ argv: spec.argv, cwd: spec.cwd, env: spec.env, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 65536 } } })
const mockSpec = (extra = []) => ({ spec: { argv: [process.execPath, MOCK, '--input-format', 'stream-json', '--output-format', 'stream-json', ...extra], cwd: ROOT, env: {} } })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const flag = (argv, name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1] }

test('manager: one process serves consecutive turns; outcomes are per turn', async () => {
  const manager = new PersistentAgySessionManager({ spawn, idleMs: 0, graceMs: 2000 })
  try {
    const turns = []
    for (const word of ['one', 'two', 'three']) turns.push(await manager.runTurn('s1', 'k', async () => mockSpec(), word, { timeoutMs: 10_000 }))
    assert.deepEqual(turns.map((t) => [t.status, t.turn, t.reused]), [['completed', 1, false], ['completed', 2, true], ['completed', 3, true]])
    assert.equal(new Set(turns.map((t) => t.pid)).size, 1)
    assert.equal(new Set(turns.map((t) => t.conversationId)).size, 1)
    assert.deepEqual(turns.map((t) => t.response), ['echo#1: one\n', 'echo#2: two\n', 'echo#3: three\n'])
    assert.equal(turns[1].text, turns[1].response, 'response equals this turn\'s own deltas (no cross-turn text)')
  } finally {
    await manager.dispose()
  }
})

test('manager: same-session turns are serialized; sessions run concurrently and stay isolated', async () => {
  const manager = new PersistentAgySessionManager({ spawn, idleMs: 0, graceMs: 2000 })
  try {
    const [a1, a2, b1] = await Promise.all([
      manager.runTurn('a', 'k', async () => mockSpec(), 'slow:300 first', { timeoutMs: 10_000 }),
      manager.runTurn('a', 'k', async () => mockSpec(), 'second', { timeoutMs: 10_000 }),
      manager.runTurn('b', 'k', async () => mockSpec(), 'other', { timeoutMs: 10_000 }),
    ])
    assert.deepEqual([a1.turn, a2.turn], [1, 2])
    assert.equal(a1.pid, a2.pid)
    assert.notEqual(a1.pid, b1.pid)
    assert.notEqual(a1.conversationId, b1.conversationId)
    assert.match(b1.response, /echo#1: other/)
  } finally {
    await manager.dispose()
  }
})

test('manager: a changed start key restarts the process; turn ERROR keeps it; idle processes are closed', async () => {
  const manager = new PersistentAgySessionManager({ spawn, idleMs: 300, graceMs: 2000 })
  try {
    const first = await manager.runTurn('s', 'model-a', async () => mockSpec(), 'hi', { timeoutMs: 10_000 })
    const failed = await manager.runTurn('s', 'model-a', async () => mockSpec(), 'fail', { timeoutMs: 10_000 })
    assert.equal(failed.status, 'failed')
    assert.equal(failed.pid, first.pid, 'a failed turn does not end the session')
    const switched = await manager.runTurn('s', 'model-b', async () => mockSpec(['--conversation', first.conversationId]), 'hi again', { timeoutMs: 10_000 })
    assert.notEqual(switched.pid, first.pid)
    assert.equal(switched.conversationId, first.conversationId, 'restart resumes the stored conversation')
    assert.equal(switched.reused, false)
    await sleep(900)
    assert.equal(manager.list()[0].state, 'closed', 'idle process closed')
  } finally {
    await manager.dispose()
  }
})

test('manager: abort kills the process (cancelled, never completed); timeout and external death are distinct', async () => {
  const manager = new PersistentAgySessionManager({ spawn, idleMs: 0, graceMs: 2000 })
  try {
    const controller = new AbortController()
    const pending = manager.runTurn('c', 'k', async () => mockSpec(), 'slow:5000', { timeoutMs: 10_000, signal: controller.signal })
    await sleep(400)
    controller.abort()
    const cancelled = await pending
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.response, '')
    const after = await manager.runTurn('c', 'k', async () => mockSpec(), 'next', { timeoutMs: 10_000 })
    assert.equal(after.status, 'completed')
    assert.notEqual(after.pid, cancelled.pid, 'a fresh process after cancellation')
    const timeout = await manager.runTurn('t', 'k', async () => mockSpec(), 'slow:5000', { timeoutMs: 300 })
    assert.equal(timeout.status, 'timeout')
    let killer
    const lost = manager.runTurn('l', 'k', async () => mockSpec(), 'slow:5000', { timeoutMs: 10_000 }, (process) => {
      killer = setTimeout(() => process.kill(), 300)
    })
    const outcome = await lost
    clearTimeout(killer)
    assert.equal(outcome.status, 'lost')
    assert.match(outcome.error, /exited without a result/)
  } finally {
    await manager.dispose()
  }
})

test('manager: dispose kills every process and refuses new turns', async () => {
  const manager = new PersistentAgySessionManager({ spawn, idleMs: 0, graceMs: 2000 })
  const first = await manager.runTurn('d', 'k', async () => mockSpec(), 'hi', { timeoutMs: 10_000 })
  assert.equal(first.status, 'completed')
  await manager.dispose()
  assert.equal(manager.list().length, 0)
  await sleep(300)
  assert.throws(() => process.kill(first.pid, 0), 'the agy process is gone after dispose (no leak)')
  await assert.rejects(manager.runTurn('d', 'k', async () => mockSpec(), 'again', { timeoutMs: 10_000 }), /shut down/)
})

function setup(prefix, extra = {}, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const ws = join(dir, 'ws')
  mkdirSync(ws)
  const h = harness(dir, options.plans ?? [], { nativeContinuableEnabled: true, nativePersistentSessions: true, nativeChatExecutionPanel: false, ...extra }, { help: HELP_STREAM, streamMock: true, ...options })
  const main = 'persistent-main-0001'
  h.agents.set(main, { id: main, session: { id: main, header: { cwd: ws } } })
  return { dir, ws, h, main }
}

async function turn(h, sessionId, text, extra = {}) {
  const chunks = []
  for await (const chunk of h.adapter.stream({ provider: 'agy-native-cli', model: 'gemini-3.8-flash', sessionId, messages: [{ role: 'user', content: [{ type: 'text', text }] }], ...extra })) chunks.push(chunk)
  return { text: chunks.find((c) => c.type === 'block-end').block.text, usage: chunks.find((c) => c.type === 'usage')?.usage }
}

test('native runner: three turns of one DSH session reuse one agy process and conversation; usage is per turn', async () => {
  const { dir, h, main } = setup('agy-persist-main-')
  try {
    const results = []
    for (const word of ['alpha', 'beta', 'gamma']) results.push(await turn(h, main, word))
    assert.equal(h.streamSpawns.length, 1, 'one process for three turns')
    const argv = h.streamSpawns[0].spec.argv
    assert.deepEqual([flag(argv, '--input-format'), flag(argv, '--output-format'), flag(argv, '--model'), flag(argv, '--effort')], ['stream-json', 'stream-json', 'gemini-3.8-flash', 'high'])
    assert.equal(argv.includes('-p'), false)
    assert.equal(argv.includes('--print-timeout'), false)
    assert.match(results[0].text, /^echo#1: \[user\]\nalpha/, 'first turn carries the full (lenient) prompt')
    assert.match(results[2].text, /^echo#3: gamma/)
    // Mock reports per call input 100*n, output 10, thinking 4, cache 50*(n-1); result.usage is cumulative.
    assert.deepEqual(results.map((r) => [r.usage.inputTokens, r.usage.outputTokens, r.usage.reasoningTokens, r.usage.cacheReadTokens]), [[100, 10, 4, 0], [200, 10, 4, 50], [300, 10, 4, 100]])
    const trace = await h.tools.get('antigravity_trace').execute({ id: main, limit: 200 }, { agent: { id: main } })
    const starts = trace.events.filter((e) => e.type === 'run_start')
    assert.deepEqual(starts.map((s) => [s.process.turn, s.process.reused]), [[1, false], [2, true], [3, true]])
    assert.equal(new Set(starts.map((s) => s.process.pid)).size, 1)
    assert.match(starts[0].mode, /native-chat-persistent-first/)
    const registry = JSON.parse(readFileSync(join(dir, 'native.json'), 'utf8'))
    assert.ok(registry[main].conversationId)
    const tasks = await h.tools.get('antigravity_tasks').execute({})
    assert.equal(tasks.persistent[0].sessionKey, main)
    assert.equal(tasks.persistent[0].turns, 3)
  } finally {
    await h.provider.disposePersistent()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native runner: stop mid-turn kills the process, reports no success, and the next turn resumes with --conversation', async () => {
  const { dir, h, main } = setup('agy-persist-cancel-')
  try {
    const first = await turn(h, main, 'hello')
    assert.match(first.text, /echo#1/)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 400)
    await assert.rejects(turn(h, main, 'slow:5000 long task', { signal: controller.signal }))
    const registry = JSON.parse(readFileSync(join(dir, 'native.json'), 'utf8'))
    const next = await turn(h, main, 'are you there')
    assert.equal(h.streamSpawns.length, 2)
    assert.equal(flag(h.streamSpawns[1].spec.argv, '--conversation'), registry[main].conversationId)
    assert.match(next.text, /echo#1: are you there/, 'a new process answers the next turn')
    const trace = await h.tools.get('antigravity_trace').execute({ id: main, limit: 200 }, { agent: { id: main } })
    const ends = trace.events.filter((e) => e.type === 'run_end').map((e) => e.outcome)
    assert.deepEqual(ends, ['completed', 'cancelled', 'completed'])
  } finally {
    await h.provider.disposePersistent()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native runner: a different model restarts the process on the same conversation', async () => {
  const { dir, h, main } = setup('agy-persist-model-')
  try {
    await turn(h, main, 'one')
    await turn(h, main, 'two', { model: 'claude-sonnet-4-6' })
    assert.equal(h.streamSpawns.length, 2)
    const second = h.streamSpawns[1].spec.argv
    assert.equal(flag(second, '--model'), 'claude-sonnet-4-6')
    assert.equal(second.includes('--effort'), false)
    assert.ok(flag(second, '--conversation'))
  } finally {
    await h.provider.disposePersistent()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native runner: a backend restart resumes the stored conversation in a new persistent process', async () => {
  const { dir, ws, h, main } = setup('agy-persist-restart-')
  try {
    await turn(h, main, 'before restart')
    await h.provider.disposePersistent()
    const conversation = JSON.parse(readFileSync(join(dir, 'native.json'), 'utf8'))[main].conversationId
    // A fresh plugin instance over the same state directory (what a backend restart looks like).
    const h2 = harness(dir, [], { nativeContinuableEnabled: true, nativePersistentSessions: true, nativeChatExecutionPanel: false }, { help: HELP_STREAM, streamMock: true })
    h2.agents.set(main, { id: main, session: { id: main, header: { cwd: ws } } })
    const after = await turn(h2, main, 'after restart')
    assert.equal(flag(h2.streamSpawns[0].spec.argv, '--conversation'), conversation)
    assert.match(after.text, /^echo#1: after restart/, 'resumed turn sends only the new message')
    await h2.provider.disposePersistent()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native runner: prompts that look like CLI slash commands never reach the streaming stdin', async () => {
  const PONG = readFileSync(join(ROOT, 'scripts', 'fixtures', 'agy-1.4.0-pong.ndjson'), 'utf8')
  const { dir, h, main } = setup('agy-persist-slash-', {}, { plans: [{ chunks: [Buffer.from(PONG)] }] })
  try {
    await turn(h, main, 'hello')
    await turn(h, main, '/model')
    assert.equal(h.streamSpawns.length, 1, 'the persistent process was not used for the slash turn')
    assert.match(flag(h.spawns[0].spec.argv, '-p'), /^\/model\n/, 'one-shot carries it instead')
    const third = await turn(h, main, 'still here')
    assert.match(third.text, /^echo#2: still here/, 'the persistent process survived')
  } finally {
    await h.provider.disposePersistent()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native runner: without documented streaming input it falls back to one process per turn', async () => {
  const PONG = readFileSync(join(ROOT, 'scripts', 'fixtures', 'agy-1.4.0-pong.ndjson'), 'utf8')
  const { dir, h, main } = setup('agy-persist-fallback-', {}, { help: undefined, plans: [{ chunks: [Buffer.from(PONG)] }] })
  try {
    const result = await turn(h, main, 'hi')
    assert.equal(result.text, 'PONG\n')
    assert.equal(h.streamSpawns.length, 0)
    assert.equal(h.spawns.length, 1)
    assert.match(flag(h.spawns[0].spec.argv, '-p'), /\[user\]\nhi/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('one-shot: a prompt longer than the command-line limit is delivered over stdin (stream-json) instead of failing', async () => {
  const PONG = readFileSync(join(ROOT, 'scripts', 'fixtures', 'agy-1.4.0-pong.ndjson'), 'utf8')
  const { dir, h, main } = setup('agy-stdin-oneshot-', { nativePersistentSessions: false }, { streamMock: false, plans: [{ chunks: [Buffer.from(PONG)] }] })
  try {
    const long = 'please review this text: ' + 'z'.repeat(40_000)
    const result = await turn(h, main, long)
    assert.equal(result.text, 'PONG\n')
    const { spec, handle } = h.spawns[0]
    assert.equal(spec.argv.includes('-p'), false)
    assert.equal(flag(spec.argv, '--input-format'), 'stream-json')
    assert.equal(flag(spec.argv, '--output-format'), 'stream-json')
    assert.equal(spec.argv.includes('--print-timeout'), false)
    assert.equal(spec.stdio.stdin, 'pipe')
    const line = JSON.parse(handle.stdinText.trim())
    assert.equal(line.event, 'user')
    assert.match(line.message.content, /z{40000}/)
    assert.equal(handle.stdinEnded, true, 'stdin is closed so agy finishes the turn and exits')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('one-shot over stdin against the protocol mock: one message, EOF, a single result', async () => {
  const { dir, h, main } = setup('agy-stdin-mock-', { nativePersistentSessions: false })
  try {
    const result = await turn(h, main, 'long ' + 'q'.repeat(30_000))
    assert.match(result.text, /^echo#1: \[user\]\nlong q/)
    assert.equal(h.streamSpawns.length, 1)
    await h.streamSpawns[0].handle.done
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('one-shot resume: DSH usage comes from this turn\'s calls, not from cumulative result.usage', async () => {
  const lines = [
    { event: 'init', conversation_id: 'conv-1', init: { cwd: 'C:/w', tools: [], permission_mode: 'always-proceed' } },
    { event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 4, state: 'DONE', step_type: 'agent_response', text_delta: 'PONG2\n', usage: { input_tokens: 2258, output_tokens: 3, thinking_tokens: 1, cache_read_tokens: 14624, total_tokens: 2261 } } },
    { event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: 'PONG2\n', num_turns: 2, usage: { input_tokens: 18931, output_tokens: 5, thinking_tokens: 2, cache_read_tokens: 14624, total_tokens: 18936 } } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n'
  const { dir, h, main } = setup('agy-usage-resume-', { nativePersistentSessions: false }, { plans: [{ chunks: [Buffer.from(lines)] }] })
  try {
    const result = await turn(h, main, 'again')
    assert.deepEqual(result.usage, { inputTokens: 2258, outputTokens: 3, cacheReadTokens: 14624, reasoningTokens: 1 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
