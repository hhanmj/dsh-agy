import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { byteChunks, harness, parentAgent, sleep } from './helpers/fake-agy.mjs'
import { NativeAgyLlmAdapter, reconcileFinalText } from '../lib/native-bridge.js'
import { AgyStreamAccumulator, NdjsonLineSplitter, parseAgyErrorLine, parseAgyStreamLine } from '../lib/stream-events.js'
import { RunTraceRecorder, TraceStore, redactSecrets, relativizePaths, sanitizeValue, summarizeTrace } from '../lib/trace.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8')
const fixtureEvents = (name) => fixture(name).split('\n').filter(Boolean).map(parseAgyStreamLine)


test('NDJSON splitter: byte-fragmented UTF-8, CRLF, overlong line and unterminated tail', () => {
  const splitter = new NdjsonLineSplitter(64)
  const text = '{"a":"中文测试"}\r\n' + 'x'.repeat(100) + '\n{"b":1}\n{"tail":true}'
  const lines = []
  for (const chunk of byteChunks(text, 3)) lines.push(...splitter.push(chunk))
  lines.push(...splitter.end())
  assert.deepEqual(lines, ['{"a":"中文测试"}', '{"b":1}', '{"tail":true}'])
  assert.equal(splitter.overflowedLines, 1)
})

test('real agy 1.4.0 stream-json fixtures parse into typed events without guessing', () => {
  const events = fixtureEvents('agy-1.4.0-tools.ndjson')
  assert.equal(events[0].kind, 'init')
  assert.equal(events[0].permissionMode, 'always-proceed')
  assert.ok(events[0].tools.includes('run_command'))
  const toolDone = events.find((e) => e.kind === 'step' && e.toolName === 'run_command' && e.state === 'DONE')
  assert.deepEqual(toolDone.toolInfo.parameters, { CommandLine: 'echo hello-agy' })
  assert.equal(toolDone.toolInfo.output, 'hello-agy\r\n')
  const toolError = events.find((e) => e.kind === 'step' && e.state === 'ERROR')
  assert.equal(toolError.toolName, 'view_file')
  assert.equal(toolError.toolInfo.error.type, 'TOOL_ERROR')
  assert.deepEqual(toolError.extra, {})
  const result = events.at(-1)
  assert.equal(result.kind, 'result')
  assert.equal(result.status, 'SUCCESS')
  assert.equal(result.response, 'DONE\n')
  assert.equal(result.numTurns, 1)
  // Unverified shapes stay opaque instead of being forced into a schema.
  const unknownStep = parseAgyStreamLine('{"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"subagent","subagent_info":{"conversation_id":"c-2"}}}')
  assert.deepEqual(unknownStep.extra, { subagent_info: { conversation_id: 'c-2' } })
  assert.equal(parseAgyStreamLine('{"event":"heartbeat"}').kind, 'unknown')
  assert.equal(parseAgyStreamLine('not json').kind, 'malformed')
  assert.equal(parseAgyStreamLine('{"conversation_id":"x","status":"SUCCESS","response":"hi"}').kind, 'reply')
})

test('result.response equals the joined text deltas (narration included), so no double append', () => {
  const acc = new AgyStreamAccumulator()
  for (const event of fixtureEvents('agy-1.4.0-narration.ndjson')) acc.apply(event)
  assert.equal(acc.response, acc.streamedText)
  assert.match(acc.response, /中文测试/)
  assert.equal(reconcileFinalText(acc.streamedText, acc.response), '')
  assert.equal(reconcileFinalText('', 'final'), 'final')
  assert.equal(reconcileFinalText('fin', 'final'), 'al')
  assert.equal(reconcileFinalText('streamed narration', 'different'), '')
})

test('AGY_ERROR stderr line is parsed when present', () => {
  assert.deepEqual(parseAgyErrorLine('noise\nAGY_ERROR: {"status":"UNAVAILABLE","retryable":true}\n'), { status: 'UNAVAILABLE', retryable: true })
  assert.equal(parseAgyErrorLine('plain failure'), undefined)
})

test('redaction removes credentials and relativizes workspace/home paths', () => {
  const text = 'curl -H "Authorization: Bearer abcdefghijklmnop123" https://u:hunter22@example.com api_key=sk-1234567890abcdefghij token: ghp_abcdefghijklmnopqrstuvwxyz0123 AIzaSyA1234567890abcdefghijklmnopqrstu'
  const red = redactSecrets(text)
  for (const secret of ['abcdefghijklmnop123', 'hunter22', 'sk-1234567890abcdefghij', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'AIzaSyA1234567890abcdefghijklmnopqrstu']) {
    assert.equal(red.includes(secret), false, secret)
  }
  assert.equal(redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----'), '[REDACTED PRIVATE KEY]')
  assert.equal(relativizePaths('C:\\agy-fixture\\ws\\note.txt and C:/agy-fixture/ws/a.txt in C:\\Users\\me\\x', { cwd: 'C:\\agy-fixture\\ws', home: 'C:\\Users\\me' }),
    '.\\note.txt and ./a.txt in ~\\x')
  const params = sanitizeValue({ CommandLine: 'echo PASSWORD=supersecret', ReplacementChunks: [{ TargetContent: 'x'.repeat(5000) }], ApiKey: 'abc', Nested: { CodeContent: 'body' } }, {})
  assert.equal(params.CommandLine.includes('supersecret'), false)
  assert.equal(params.ReplacementChunks, '[omitted 1 items]')
  assert.equal(params.ApiKey, '[REDACTED]')
  assert.equal(params.Nested.CodeContent, '[omitted 4 chars]')
})

test('trace store: owner fold, cursor paging, cap with lifecycle reserve, torn-line tolerance, rotation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-trace-store-'))
  try {
    const store = new TraceStore(dir, { maxEventsPerTrace: 5, maxBytesPerTrace: 1 << 20, maxTraces: 3 })
    store.ensure({ trace_key: 'child-1', kind: 'native', owner: null, child_id: 'child-1' })
    store.ensure({ trace_key: 'child-1', kind: 'native', owner: 'parent-A', child_id: 'child-1' })
    store.ensure({ trace_key: 'child-1', kind: 'native', owner: 'parent-B', child_id: 'child-1' })
    assert.equal(store.readMeta('child-1').owner, 'parent-A')
    for (let i = 0; i < 10; i += 1) store.append('child-1', { type: 'tool_call', step: i })
    assert.notEqual(store.append('child-1', { type: 'run_end', outcome: 'completed' }, true), undefined)
    const all = store.readAll('child-1').records
    assert.ok(all.some((r) => r.type === 'trace_truncated'))
    assert.equal(all.at(-1).type, 'run_end')
    const seqs = all.map((r) => r.seq)
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
    const page = store.page('child-1', 0, 2)
    assert.equal(page.events.length, 2)
    assert.equal(page.hasMore, true)
    const next = store.page('child-1', page.nextCursor, 100)
    assert.equal(next.events[0].seq, page.nextCursor + 1)
    appendFileSync(store.fileOf('child-1'), '{"seq": 99, "type": "torn')
    assert.equal(store.readAll('child-1').records.at(-1).type, 'run_end')
    for (const key of ['k2', 'k3', 'k4', 'k5']) store.ensure({ trace_key: key, kind: 'task', owner: 'p', child_id: null })
    assert.equal(readdirSync(dir).filter((n) => n.endsWith('.ndjson')).length, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run recorder turns real tool events into AGY-internal records and a four-stage summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-trace-rec-'))
  try {
    const store = new TraceStore(dir)
    store.ensure({ trace_key: 'task-1', kind: 'task', owner: 'parent', child_id: null })
    const recorder = new RunTraceRecorder(store, 'task-1', 'run-1', { cwd: 'C:\\agy-fixture\\ws' })
    recorder.start({ mode: 'foreground', label: 'probe', resumed: false, transport: 'stream-json' })
    for (const event of fixtureEvents('agy-1.4.0-tools.ndjson')) recorder.onEvent(event)
    const live = store.readAll('task-1')
    const running = summarizeTrace(live.meta, live.records, new Set(['run-1']))
    assert.equal(running.lifecycle.execution, 'running')
    assert.equal(running.lifecycle.evidence, 'pending')
    recorder.end({ outcome: 'completed', exit_code: 0, signal: null, timed_out: false, cancelled: false })
    recorder.evidence({
      task_id: 'run-1', execution_status: 'completed', conversation_id: 'c', changed_files: [{ path: 'note.txt', change: 'added' }],
      diff_summary: { added_files: 1, modified_files: 0, deleted_files: 0, changed_files_total: 1, added_lines: null, deleted_lines: null },
      warnings: [], evidence_complete: true,
    })
    const { meta, records } = store.readAll('task-1')
    const calls = records.filter((r) => r.type === 'tool_call')
    assert.deepEqual(calls.map((r) => r.tool), ['run_command', 'view_file', 'write_to_file', 'view_file'])
    assert.deepEqual(calls[1].parameters, { AbsolutePath: '.\\missing.txt' })
    const failed = records.find((r) => r.type === 'tool_result' && r.error)
    assert.equal(failed.tool, 'view_file')
    assert.equal(failed.state, 'ERROR')
    assert.equal(failed.error.includes('C:/agy-fixture/ws'), false)
    assert.equal(records.filter((r) => r.type === 'response_step').at(-1).text_preview, 'DONE\n')
    const end = records.find((r) => r.type === 'run_end')
    assert.equal(end.tool_calls, 4)
    assert.equal(end.tool_errors, 1)
    assert.equal(end.conversation_id, '00000000-0000-4000-8000-000000000002')
    const summary = summarizeTrace(meta, records, new Set())
    assert.deepEqual(summary.lifecycle, { started: true, execution: 'completed', evidence: 'collected', review: 'pending' })
    assert.deepEqual(summary.tools_used.view_file, { calls: 2, errors: 1 })
    assert.equal(summary.current_run.evidence.changed_files_total, 1)
    // No DSH tool-call vocabulary and no reasoning text is ever recorded.
    assert.equal(records.some((r) => /tool-call-delta|reasoning/.test(r.type)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a real PreToolUse hook denial (agy 1.4.0, skip-permissions) is traced as an AGY tool error with its reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-trace-hook-'))
  try {
    const store = new TraceStore(dir)
    store.ensure({ trace_key: 't', kind: 'task', owner: 'p', child_id: null })
    const recorder = new RunTraceRecorder(store, 't', 'r', {})
    for (const event of fixtureEvents('agy-1.4.0-hook-deny.ndjson')) recorder.onEvent(event)
    const results = store.readAll('t').records.filter((r) => r.type === 'tool_result')
    assert.equal(results.length, 2)
    assert.equal(results[0].state, 'DONE')
    assert.equal(results[1].state, 'ERROR')
    assert.match(results[1].error, /denied by pre-tool hook: Blocked by DSH supervision probe hook/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native adapter yields AGY text deltas while the run is still executing', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const adapter = new NativeAgyLlmAdapter('agy-native-cli', async (_options, sink) => {
    sink.text('hello ')
    await gate
    sink.text('world')
    return 'hello world'
  })
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'agy-native-cli', model: 'agy-cli', messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] })) {
    chunks.push(chunk)
    if (chunk.type === 'text-delta' && chunk.text === 'hello ') release()
  }
  assert.deepEqual(chunks.map((c) => c.type), ['block-start', 'text-delta', 'text-delta', 'block-end', 'finish'])
  assert.equal(chunks[3].block.text, 'hello world')
})

test('native adapter: failure after partial text throws; early consumer exit aborts the runner', async () => {
  const failing = new NativeAgyLlmAdapter('agy-native-cli', async (_options, sink) => {
    sink.text('partial')
    throw new Error('AGY transport failed')
  })
  const seen = []
  await assert.rejects(async () => {
    for await (const chunk of failing.stream({ provider: 'agy-native-cli', model: 'agy-cli', messages: [] })) seen.push(chunk.type)
  }, /AGY transport failed/)
  assert.deepEqual(seen, ['block-start', 'text-delta'])
  let runnerSignal
  const hanging = new NativeAgyLlmAdapter('agy-native-cli', (options, sink) => {
    runnerSignal = options.signal
    sink.text('first')
    return new Promise(() => {})
  })
  for await (const chunk of hanging.stream({ provider: 'agy-native-cli', model: 'agy-cli', messages: [] })) {
    if (chunk.type === 'text-delta') break
  }
  assert.equal(runnerSignal.aborted, true)
})

test('provider run uses stream-json, forwards live text, keeps result semantics and records a trace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-stream-run-'))
  try {
    const h = harness(dir, [{ chunks: byteChunks(fixture('agy-1.4.0-narration.ndjson'), 5) }])
    const deltas = []
    const run = await h.provider.startWithDirs(
      { label: 'stream probe', parent: parentAgent(dir), prompt: [{ type: 'text', text: 'go' }], signal: new AbortController().signal },
      [], { cwd: dir, stream: { onText: (d) => deltas.push(d) } },
    )
    const result = await run.result
    await run.dispose()
    const argv = h.spawns[0].spec.argv
    assert.deepEqual(argv.slice(argv.indexOf('--output-format'), argv.indexOf('--output-format') + 2), ['--output-format', 'stream-json'])
    assert.equal(result.stopReason, 'completed')
    assert.equal(deltas.join(''), result.output[0].text)
    assert.ok(deltas.length > 3)
    assert.equal(h.provider.recordOf(run.id).conversationId, '00000000-0000-4000-8000-000000000003')
    const trace = await h.tools.get('antigravity_trace').execute({ id: run.id }, { agent: parentAgent(dir) })
    assert.equal(trace.summary.lifecycle.execution, 'completed')
    assert.equal(trace.summary.current_run.transport, 'stream-json')
    assert.deepEqual(Object.keys(trace.summary.tools_used).sort(), ['run_command', 'write_to_file'])
    assert.match(trace.source, /not DSH tool calls/)
    const rendered = h.tools.get('antigravity_trace').output.render({}, trace)[0].text
    assert.match(rendered, /tool_call step 2 run_command/)
    assert.match(rendered, /review=pending/)
    await assert.rejects(h.tools.get('antigravity_trace').execute({ id: run.id }, { agent: parentAgent(dir, 'someone-else') }), /no trace/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('provider run: AGY failure exit 3 with AGY_ERROR, and cancellation, end as failed/cancelled in the trace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-stream-fail-'))
  try {
    const failure = [
      '{"event":"init","conversation_id":"conv-f","init":{"cwd":"x","tools":[],"permission_mode":"always-proceed"}}',
      '{"event":"step_update","step_update":{"conversation_id":"conv-f","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"partial"}}',
      '{"event":"result","result":{"conversation_id":"conv-f","status":"ERROR","response":"partial","error":{"type":"MODEL_ERROR","message":"quota exhausted"}}}',
    ].join('\n') + '\n'
    const h = harness(dir, [
      { chunks: [Buffer.from(failure)], exitCode: 3, stderr: 'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","retryable":false}\n' },
      { chunks: [Buffer.from('{"event":"init","conversation_id":"conv-c","init":{"tools":[]}}\n')], hang: true },
    ])
    const request = (signal) => ({ label: 'x', parent: parentAgent(dir), prompt: [{ type: 'text', text: 'go' }], signal })
    const failed = await h.provider.startWithDirs(request(new AbortController().signal), [], { cwd: dir })
    const failedResult = await failed.result
    await failed.dispose()
    assert.equal(failedResult.stopReason, 'error')
    assert.match(failedResult.output[0].text, /quota exhausted/)
    const failTrace = await h.tools.get('antigravity_trace').execute({ id: failed.id }, { agent: parentAgent(dir) })
    const end = failTrace.events.find((e) => e.type === 'run_end')
    assert.equal(end.outcome, 'failed')
    assert.equal(end.exit_code, 3)
    assert.deepEqual(end.agy_error, { status: 'RESOURCE_EXHAUSTED', retryable: false })

    const controller = new AbortController()
    const hung = await h.provider.startWithDirs(request(controller.signal), [], { cwd: dir })
    await sleep(30)
    const live = await h.tools.get('antigravity_trace').execute({ id: hung.id }, { agent: parentAgent(dir) })
    assert.equal(live.summary.lifecycle.execution, 'running')
    assert.equal(live.summary.active, true)
    controller.abort()
    const cancelled = await hung.result
    await hung.dispose()
    assert.equal(cancelled.stopReason, 'aborted')
    const after = await h.tools.get('antigravity_trace').execute({ id: hung.id, cursor: live.next_cursor }, { agent: parentAgent(dir) })
    assert.equal(after.events.find((e) => e.type === 'run_end').outcome, 'cancelled')
    assert.equal(after.summary.lifecycle.execution, 'cancelled')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native child turn streams real deltas into DSH, records child trace + linked file evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-native-stream-'))
  try {
    // Plugin state (traces, evidence, registries) lives outside the delegated workspace.
    const ws = join(dir, 'workspace')
    mkdirSync(ws)
    const h = harness(dir, [{
      chunks: byteChunks(fixture('agy-1.4.0-narration.ndjson'), 128), delayMs: 2,
      beforeExit: () => writeFileSync(join(ws, 'a.txt'), '中文测试'),
    }], { nativeContinuableEnabled: true })
    const childId = '11111111-2222-4333-8444-555555555555'
    h.agents.set(childId, { id: childId, session: { id: childId, header: { cwd: ws } } })
    await h.provider.prepareContinuable({ sessionId: childId, parent: { id: 'session-parent' }, signal: new AbortController().signal })
    const chunks = []
    for await (const chunk of h.adapter.stream({
      provider: 'agy-native-cli', model: 'agy-cli', sessionId: childId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'make a.txt' }] }],
    })) chunks.push(chunk)
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text)
    assert.ok(deltas.length > 3, 'expected incremental deltas, not one final blob')
    const final = chunks.find((c) => c.type === 'block-end').block.text
    assert.equal(deltas.join(''), final)
    assert.match(final, /FINAL:/)
    assert.equal(chunks.some((c) => c.type === 'tool-call-delta' || c.type === 'reasoning-delta'), false)
    assert.equal(JSON.parse(readFileSync(join(dir, 'native.json'), 'utf8'))[childId].conversationId, '00000000-0000-4000-8000-000000000003')
    const trace = await h.tools.get('antigravity_trace').execute({ id: childId }, { agent: { id: 'session-parent' } })
    assert.equal(trace.summary.kind, 'native')
    assert.equal(trace.summary.current_run.mode, 'native-first')
    assert.deepEqual(trace.summary.lifecycle, { started: true, execution: 'completed', evidence: 'collected', review: 'pending' })
    assert.equal(trace.summary.current_run.evidence.changed_files_total, 1)
    const evidence = await h.tools.get('antigravity_evidence').execute({ task: trace.summary.current_run.evidence.task })
    assert.equal(evidence.evidence.changed_files[0].path, 'a.txt')
    await assert.rejects(h.tools.get('antigravity_trace').execute({ id: childId }, { agent: { id: childId } }), /no trace/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('background job output gets UTF-8-safe deltas, tool markers, trace line and linked evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-bg-stream-'))
  try {
    const h = harness(dir, [{ chunks: byteChunks(fixture('agy-1.4.0-tools.ndjson') + fixture('agy-1.4.0-narration.ndjson').split('\n').filter((l) => l.includes('中文')).join('\n') + '\n', 7) }])
    const bg = await h.provider.startBackground({ label: 'bg', parent: parentAgent(dir), prompt: [{ type: 'text', text: 'go' }], signal: new AbortController().signal }, [], { cwd: dir })
    const outcome = await bg.done
    assert.equal(outcome.status, 'completed')
    const text = bg.readOutput()
    assert.match(text, /\[agy: tool run_command done\]/)
    assert.match(text, /\[agy: tool view_file error: TOOL_ERROR: /)
    assert.match(text, /中文测试/)
    assert.equal(text.includes('\uFFFD'), false)
    assert.match(text, /\[trace: antigravity_trace with id /)
    const trace = await h.tools.get('antigravity_trace').execute({ id: bg.id }, { agent: parentAgent(dir) })
    assert.equal(trace.summary.current_run.mode, 'background')
    assert.equal(trace.summary.lifecycle.evidence, 'collected')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('concurrent runs keep separate traces with strictly increasing seq', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-concurrent-'))
  try {
    const h = harness(dir, [
      { chunks: byteChunks(fixture('agy-1.4.0-tools.ndjson'), 211), delayMs: 1 },
      { chunks: byteChunks(fixture('agy-1.4.0-narration.ndjson'), 197), delayMs: 1 },
    ])
    const start = (key) => h.provider.startWithDirs(
      { label: key, parent: parentAgent(dir), prompt: [{ type: 'text', text: key }], signal: new AbortController().signal },
      [], { cwd: dir, stream: { traceKey: key } })
    const runs = await Promise.all([start('trace-A'), start('trace-B')])
    await Promise.all(runs.map((run) => run.result))
    for (const key of ['trace-A', 'trace-B']) {
      const trace = await h.tools.get('antigravity_trace').execute({ id: key, limit: 200 }, { agent: parentAgent(dir) })
      const seqs = trace.events.map((e) => e.seq)
      assert.deepEqual(seqs, seqs.map((_, i) => i + 1))
      assert.equal(trace.events.filter((e) => e.type === 'run_start').length, 1)
      assert.equal(trace.events.every((e) => e.run === runs[key === 'trace-A' ? 0 : 1].id), true)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
