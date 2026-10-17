#!/usr/bin/env node
/**
 * Mock Antigravity CLI for the documented streaming-input protocol (agy 1.4.0
 * headless docs, "Stream prompts from stdin"). NOT the real CLI: it lets tests
 * exercise stdin/stdout plumbing, per-turn result detection, cumulative
 * counters, input validation and termination without an account.
 *
 *   node mock-agy-stream.mjs --input-format stream-json --output-format stream-json [--conversation ID] [--model M]
 *
 * Prompt directives: "slow:<ms>" delays the turn; "tool:<cmd>" emits a tool step;
 * "fail" ends the turn with status ERROR (session continues).
 */
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
if (flag('--input-format') !== 'stream-json' || flag('--output-format') !== 'stream-json') {
  process.stderr.write('mock: --input-format stream-json requires --output-format stream-json\n')
  process.exit(1)
}
if (args.includes('-p') || args.includes('--print')) process.stderr.write('mock: prompt flag ignored in streaming mode\n')
const conversation = flag('--conversation') ?? '00000000-0000-4000-8000-' + String(process.pid).padStart(12, '0')
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const total = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 }
let turns = 0
let seconds = 0
let step = 0
emit({ event: 'init', conversation_id: conversation, init: { cwd: process.cwd(), tools: ['run_command'], permission_mode: 'always-proceed', model: flag('--model') ?? null, pid: process.pid } })

const queue = []
let busy = false
let closing = false
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function turn(content) {
  turns += 1
  const started = Date.now()
  const su = (s) => emit({ event: 'step_update', step_update: { conversation_id: conversation, step_index: step++, ...s } })
  su({ state: 'DONE', step_type: 'user_input' })
  const slow = /slow:(\d+)/.exec(content)
  if (slow) await sleep(Number(slow[1]))
  const tool = /tool:(.+)$/.exec(content)
  if (tool) {
    const index = step++
    emit({ event: 'step_update', step_update: { conversation_id: conversation, step_index: index, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: tool[1] } } } })
    await sleep(20)
    emit({ event: 'step_update', step_update: { conversation_id: conversation, step_index: index, state: 'DONE', step_type: 'tool', tool_name: 'run_command', duration_seconds: 0.02, tool_info: { name: 'run_command', parameters: { CommandLine: tool[1] }, output: 'ok' } } })
  }
  const reply = 'echo#' + turns + ': ' + content.slice(0, 40) + '\n'
  const usage = { input_tokens: 100 * turns, output_tokens: 10, thinking_tokens: 4, cache_read_tokens: 50 * (turns - 1) }
  su({ state: 'DONE', step_type: 'agent_response', text_delta: reply, usage: { ...usage, total_tokens: usage.input_tokens + usage.output_tokens } })
  for (const key of Object.keys(usage)) total[key] += usage[key]
  total.total_tokens = total.input_tokens + total.output_tokens
  seconds += (Date.now() - started) / 1000
  const failed = content.trim() === 'fail'
  emit({ event: 'result', result: { conversation_id: conversation, status: failed ? 'ERROR' : 'SUCCESS', response: failed ? '' : reply, ...(failed ? { error: 'mock turn failure' } : {}), duration_seconds: Number(seconds.toFixed(3)), num_turns: turns, usage: { ...total } } })
}

function fatal(code, message) {
  emit({ event: 'result', result: { conversation_id: conversation, status: 'ERROR', response: '', error: message, duration_seconds: seconds, num_turns: turns, usage: { ...total } } })
  process.exit(code)
}

async function pump() {
  if (busy) return
  busy = true
  while (queue.length > 0) {
    const line = queue.shift()
    let message
    try { message = JSON.parse(line) } catch { fatal(1, 'invalid JSON input line') }
    if (typeof message?.event !== 'string') fatal(1, 'message missing the event field')
    if (message.event === 'control_request' || message.event === 'control_response') fatal(2, 'unsupported control message')
    if (message.event !== 'user') { process.stderr.write('warning: ignoring unsupported stream input message event "' + message.event + '"\n'); continue }
    const content = message.message?.content
    if (Array.isArray(content) && content.some((block) => block?.type !== 'text')) fatal(1, 'content block type other than text')
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((block) => block.text).join('\n') : ''
    if (text.trim().startsWith('/')) fatal(2, 'slash commands are not supported in a streaming session')
    await turn(text)
  }
  busy = false
  if (closing) process.exit(0)
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => { if (line.trim().length > 0) { queue.push(line); void pump() } })
rl.on('close', () => { closing = true; if (!busy) process.exit(0) })
