#!/usr/bin/env node
/**
 * OPT-IN real-CLI verification of the streaming-input protocol (spends a little AGY quota):
 *   node scripts/live-persistent-probe.mjs
 * Isolated temp workspace; checks init-once, per-turn results, cumulative counters,
 * tool events, termination, --conversation resume in streaming mode, stdin close,
 * and compares cold one-shot vs persistent follow-up latency (medians).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { subprocess } = await import(pathToFileURL(join(ROOT, 'scripts/helpers/node-subprocess.mjs')).href)
const { NdjsonLineSplitter, parseAgyStreamLine } = await import(pathToFileURL(join(ROOT, 'lib/stream-events.js')).href)
let proxy = ''
try { proxy = readFileSync(join(homedir(), '.dsh', 'agy-proxy.txt'), 'utf8').trim() } catch {}
const env = proxy ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy } : {}
const exe = await subprocess.resolveExecutable('agy', process.env)
const ws = mkdtempSync(join(tmpdir(), 'agy-persist-ws-'))
const MODEL = ['--model', 'gemini-3.8-flash', '--effort', 'low']
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2 }

class Session {
  constructor(extra = []) {
    this.started = performance.now()
    this.handle = subprocess.spawn({ argv: [exe, '--input-format', 'stream-json', '--output-format', 'stream-json', '--dangerously-skip-permissions', ...MODEL, ...extra],
      cwd: ws, env, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 65536 } } })
    this.splitter = new NdjsonLineSplitter(); this.events = []; this.waiters = []; this.inits = 0
    this.init = new Promise((resolve) => { this.resolveInit = resolve })
    this.handle.stdout.on('data', (chunk) => {
      for (const line of this.splitter.push(chunk)) {
        const event = parseAgyStreamLine(line); if (!event) continue
        if (event.kind === 'init') { this.inits += 1; this.initMs = performance.now() - this.started; this.resolveInit(event) }
        this.events.push(event); for (const w of this.waiters.splice(0)) w()
      }
    })
    this.exit = this.handle.done
  }
  async next(pred) {
    for (;;) {
      const i = this.events.findIndex(pred); if (i >= 0) return this.events.splice(0, i + 1)
      const closed = await Promise.race([new Promise((r) => this.waiters.push(() => r(false))), this.exit.then(() => true)])
      if (closed && this.events.findIndex(pred) < 0) return undefined
    }
  }
  async ask(content) {
    const t0 = performance.now()
    this.handle.stdin.write(JSON.stringify({ event: 'user', message: { content } }) + '\n')
    const turn = await this.next((e) => e.kind === 'result')
    if (!turn) return { lost: true }
    const result = turn.at(-1)
    const text = turn.filter((e) => e.kind === 'step' && e.textDelta).map((e) => e.textDelta).join('')
    const stepUsage = turn.filter((e) => e.kind === 'step' && e.usage).map((e) => e.usage)
    const tools = turn.filter((e) => e.kind === 'step' && (e.toolName || e.toolInfo)).map((e) => (e.toolName ?? e.toolInfo?.name) + ':' + e.state)
    return { ms: performance.now() - t0, status: result.status, response: result.response, text, numTurns: result.numTurns, usage: result.usage, duration: result.durationSeconds, conversation: result.conversationId, stepUsage, tools }
  }
}

let failures = 0
const ok = (c, l) => { console.log((c ? '  PASS  ' : '  FAIL  ') + l); if (!c) failures += 1 }
try {
  const a = new Session()
  const init = await a.init
  console.log('init after ' + Math.round(a.initMs) + ' ms, conversation ' + init.conversationId + ', pid ' + a.handle.pid)
  const words = ['one', 'two', 'three', 'four']
  const turns = []
  for (const w of words) turns.push(await a.ask('Reply with exactly the single word: ' + w + '. Do not use any tools.'))
  for (const [i, t] of turns.entries()) console.log('turn ' + (i + 1) + ': ' + Math.round(t.ms) + ' ms ' + t.status + ' ' + JSON.stringify(t.response) + ' num_turns=' + t.numTurns + ' usage=' + JSON.stringify(t.usage) + ' step_usage=' + JSON.stringify(t.stepUsage))
  ok(a.inits === 1 && turns.every((t) => t.conversation === init.conversationId), 'one init; every turn on the same conversation_id and process')
  ok(turns.every((t, i) => new RegExp(words[i], 'i').test(t.response) && t.response === t.text), 'each result.response is that turn only and equals its text deltas')
  ok(turns[3].numTurns === 4, 'num_turns is cumulative (' + turns.map((t) => t.numTurns).join(',') + ')')
  const inputs = turns.map((t) => t.usage?.input_tokens ?? 0)
  ok(inputs.every((v, i) => i === 0 || v >= inputs[i - 1]), 'result.usage is non-decreasing across turns (cumulative): ' + inputs.join(' → '))
  const perTurnSum = turns.map((t) => t.stepUsage.reduce((s, u) => s + (u.input_tokens ?? 0), 0))
  console.log('per-turn step input sums: ' + perTurnSum.join(', ') + ' ; result input diffs: ' + inputs.map((v, i) => v - (inputs[i - 1] ?? 0)).join(', '))
  const tool = await a.ask('Run the shell command: echo persistent-ok . Then reply with exactly its output.')
  console.log('tool turn: ' + Math.round(tool.ms) + ' ms ' + JSON.stringify(tool.response) + ' tools=' + tool.tools.join(','))
  ok(/persistent-ok/.test(tool.response) && tool.tools.some((x) => /ACTIVE/.test(x)) && tool.tools.some((x) => /DONE/.test(x)), 'tool ACTIVE and DONE step updates arrive inside the turn')
  // unknown event is skipped without ending the session
  a.handle.stdin.write(JSON.stringify({ event: 'future_thing' }) + '\n')
  const alive = await a.ask('Reply with exactly the single word: alive.')
  ok(/alive/i.test(alive.response ?? ''), 'unknown input event skipped; session continues')
  // cancel mid-turn
  const pending = a.ask('Write the numbers from 1 to 400, one per line, with no other text.')
  await new Promise((r) => setTimeout(r, 2500))
  a.handle.terminate()
  const cancelled = await pending
  const exitA = await a.exit
  ok(cancelled.lost === true && exitA.exitCode !== 0, 'terminate mid-turn: no result, non-zero exit (' + JSON.stringify(exitA) + ')')

  // resume in streaming mode on the stored conversation
  const b = new Session(['--conversation', init.conversationId])
  const binit = await b.init
  const recall = await b.ask('What single word did I ask you to reply with in my very first message? Reply with that word only.')
  console.log('resume: init conversation ' + binit.conversationId + ', reply ' + JSON.stringify(recall.response) + ', num_turns=' + recall.numTurns + ', usage=' + JSON.stringify(recall.usage))
  ok(binit.conversationId === init.conversationId && /one/i.test(recall.response ?? ''), 'a new streaming process resumes the stored conversation with its history')
  // persistent follow-up latency
  const persistentMs = []
  for (const w of ['red', 'green', 'blue']) { const t = await b.ask('Reply with exactly the single word: ' + w + '.'); persistentMs.push(t.ms) }
  b.handle.stdin.write(JSON.stringify({ event: 'user', message: { content: 'Reply with exactly the single word: bye.' } }) + '\n')
  b.handle.stdin.end()
  const last = await b.next((e) => e.kind === 'result')
  const exitB = await b.exit
  ok(last !== undefined && /bye/i.test(last.at(-1).response ?? '') && exitB.exitCode === 0, 'closing stdin delivers the in-flight result, then exits 0')

  // cold one-shot resume latency (same conversation, same model)
  const coldMs = []
  for (const w of ['cyan', 'magenta', 'yellow']) {
    const t0 = performance.now()
    const h = subprocess.spawn({ argv: [exe, '-p', 'Reply with exactly the single word: ' + w + '.', '--output-format', 'stream-json', '--dangerously-skip-permissions', ...MODEL, '--conversation', init.conversationId],
      cwd: ws, env, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 65536 } } })
    const done = await h.done
    coldMs.push(performance.now() - t0)
    const out = h.collected.stdout.readFrom(0).text
    if (done.exitCode !== 0 || !new RegExp(w, 'i').test(out)) console.log('cold run ' + w + ' unexpected: exit ' + done.exitCode)
  }
  console.log('latency ms — cold one-shot (resume): ' + coldMs.map(Math.round).join(', ') + ' median ' + Math.round(median(coldMs)))
  console.log('latency ms — persistent follow-up:   ' + persistentMs.map(Math.round).join(', ') + ' median ' + Math.round(median(persistentMs)))
  console.log('process startup to init: ' + Math.round(a.initMs) + ' / ' + Math.round(b.initMs) + ' ms')
} finally {
  rmSync(ws, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nLIVE PERSISTENT PROBE: all checks passed' : '\nLIVE PERSISTENT PROBE: ' + failures + ' check(s) failed')
process.exit(failures === 0 ? 0 : 1)
