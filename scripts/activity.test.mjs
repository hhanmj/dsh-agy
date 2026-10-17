import test from 'node:test'
import assert from 'node:assert/strict'
import { ActivityTracker } from '../lib/activity.js'

const step = (s) => ({ kind: 'step', ...s })

test('activity: ACTIVE/DONE/ERROR of one step update ONE record; unknown step types keep their raw identifier', () => {
  const tracker = new ActivityTracker({ sessionId: 's', runId: 'r', traceRef: 's', sanitize: { home: 'C:\\Users\\me', cwd: 'C:\\work' } })
  const started = tracker.observe(step({ stepIndex: 2, state: 'ACTIVE', stepType: 'tool', toolName: 'run_command', toolInfo: { name: 'run_command', parameters: { CommandLine: 'npm test' } } }), 1000)
  assert.deepEqual([started.state, started.summary, started.type], ['running', 'npm test', 'tool'])
  const done = tracker.observe(step({ stepIndex: 2, state: 'DONE', stepType: 'tool', toolName: 'run_command', durationSeconds: 3.25, toolInfo: { name: 'run_command', parameters: { CommandLine: 'npm test' }, output: 'ok 12 tests' } }), 4000)
  assert.deepEqual([done.state, done.durationMs, done.detail, done.timestamp, done.updatedAt], ['completed', 3250, 'ok 12 tests', 1000, 4000])
  const failed = tracker.observe(step({ stepIndex: 4, state: 'DONE', stepType: 'tool', toolName: 'view_file', toolInfo: { name: 'view_file', parameters: { AbsolutePath: 'C:\\work\\missing.txt' }, error: { type: 'NotFound', message: 'no such file C:\\Users\\me\\secret' } } }))
  assert.equal(failed.state, 'failed', 'a DONE step carrying an error is a failure')
  assert.doesNotMatch(failed.detail, /C:\\Users\\me/, 'home paths are redacted')
  const odd = tracker.observe(step({ stepIndex: 5, state: 'DONE', stepType: 'browser_frame' }))
  assert.deepEqual([odd.type, odd.rawType], ['other', 'browser_frame'])
  assert.equal(tracker.observe(step({ stepIndex: 0, state: 'DONE', stepType: 'user_input' })), undefined)
  assert.deepEqual(tracker.tools().map((r) => [r.stepIndex, r.state]), [[2, 'completed'], [4, 'failed']])
  assert.equal(tracker.list().length, 3)
})

test('activity: secrets in tool parameters never reach a record; thinking is counted, not exposed', () => {
  const tracker = new ActivityTracker({ sessionId: 's', runId: 'r', sanitize: {} })
  const record = tracker.observe(step({ stepIndex: 1, state: 'DONE', stepType: 'tool', toolName: 'run_command', toolInfo: { name: 'run_command', parameters: { CommandLine: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456" https://x' } } }))
  assert.doesNotMatch(record.summary, /abcdefghijklmnopqrstuvwxyz123456/)
  tracker.observe(step({ stepIndex: 2, state: 'DONE', stepType: 'agent_response', textDelta: 'hi', usage: { input_tokens: 1, output_tokens: 9, thinking_tokens: 7 } }))
  tracker.observe(step({ stepIndex: 3, state: 'DONE', stepType: 'agent_response', usage: { input_tokens: 1, output_tokens: 2, thinking_tokens: 3 } }))
  assert.equal(tracker.thinkingTokens, 10)
  assert.equal(JSON.stringify(tracker.list()).includes('hi'), false, 'response text is not duplicated into activity records')
})
