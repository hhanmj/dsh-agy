import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAX_PROMPT_CHARS, NativeAgyLlmAdapter, nativePrompt } from '../lib/native-bridge.js'
import { harness } from './helpers/fake-agy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PONG = readFileSync(join(ROOT, 'scripts', 'fixtures', 'agy-1.4.0-pong.ndjson'), 'utf8')
const flag = (argv, name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1] }
const req = (messages, extra = {}) => ({ provider: 'agy-native-cli', model: 'agy-cli', messages, ...extra })
const text = (t) => [{ type: 'text', text: t }]

test('lenient rendering (main session): no DSH system prompt, DSH tool traffic omitted with notes, newest history kept', () => {
  const messages = [
    { role: 'system', content: text('DSH SYSTEM PROMPT about run_code and other host tools') },
    { role: 'user', content: text('first question') },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'hidden thoughts' }, { type: 'text', text: 'let me check' }, { type: 'tool-call', id: 'c1', name: 'run_code', arguments: '{}' }] },
    { role: 'tool', content: text('tool output') },
    { role: 'user', content: [{ type: 'text', text: 'look at this' }, { type: 'image', attachment: { attachmentId: 'img-1' } }] },
  ]
  const prompt = nativePrompt(req(messages, { system: 'ONE-SHOT SYSTEM' }), false, { mode: 'lenient', image: () => '[Attached image saved at C:/tmp/a.png]' })
  assert.doesNotMatch(prompt, /DSH SYSTEM PROMPT|ONE-SHOT SYSTEM|hidden thoughts|tool output/)
  assert.match(prompt, /\[earlier DSH tool call run_code omitted\]/)
  assert.match(prompt, /2 earlier DSH tool call\(s\)\/result\(s\) were omitted/)
  assert.match(prompt, /look at this\n\[Attached image saved at C:\/tmp\/a\.png\]/)
  // Strict (child) mode still fails closed on the same history.
  assert.throws(() => nativePrompt(req(messages), false), /unsupported (DSH message role tool|request block reasoning)/)
  // Images without a saved file: strict rejects, lenient notes the omission.
  assert.throws(() => nativePrompt(req([{ role: 'user', content: [{ type: 'image', attachment: {} }] }]), false), /unsupported request block image/)
  assert.match(nativePrompt(req([{ role: 'user', content: [{ type: 'image', attachment: {} }] }]), false, { mode: 'lenient' }), /\[image omitted/)
  // Strict mode accepts an image when the runner saved it.
  assert.match(nativePrompt(req([{ role: 'user', content: [{ type: 'image', attachment: {} }] }]), false, { image: () => '[img]' }), /\[img\]/)
})

test('lenient rendering trims the oldest history to the CLI limit; the latest message alone must fit', () => {
  const big = 'x'.repeat(9_000)
  const history = [1, 2, 3, 4].flatMap((n) => [{ role: 'user', content: text(big + n) }, { role: 'assistant', content: text('ok ' + n) }])
  history.push({ role: 'user', content: text('latest question') })
  assert.throws(() => nativePrompt(req(history), false), /first-turn prompt exceeds/)
  const trimmed = nativePrompt(req(history), false, { mode: 'lenient' })
  assert.ok(trimmed.length <= MAX_PROMPT_CHARS)
  assert.match(trimmed, /earlier message\(s\) omitted to fit/)
  assert.match(trimmed, /latest question/)
  assert.throws(() => nativePrompt(req([{ role: 'user', content: text('y'.repeat(MAX_PROMPT_CHARS + 1)) }]), false, { mode: 'lenient' }), /latest message alone exceeds/)
})

test('adapter declares image input only when the runner can hand images over', async () => {
  const withImages = new NativeAgyLlmAdapter('agy-native-cli', async () => '', undefined, true)
  assert.deepEqual((await withImages.resolveModel('agy-native-cli', 'agy-cli')).inputModalities, ['text', 'image'])
  const textOnly = new NativeAgyLlmAdapter('agy-native-cli', async () => '')
  assert.deepEqual((await textOnly.resolveModel('agy-native-cli', 'agy-cli')).inputModalities, ['text'])
})

function setup(prefix, plans, options = {}, extraConfig = {}) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const ws = join(dir, 'ws')
  mkdirSync(ws)
  const h = harness(dir, plans, { nativeContinuableEnabled: true, ...extraConfig }, options)
  const main = 'main-session-0001'
  h.agents.set(main, { id: main, session: { id: main, header: { cwd: ws } } })
  return { dir, ws, h, main }
}

async function drain(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks.find((c) => c.type === 'block-end').block.text
}

test('a main session that selected an AGY model chats through AGY and keeps one AGY conversation; its trace is its own', async () => {
  const { dir, h, main } = setup('agy-chat-main-', [{ chunks: [Buffer.from(PONG)] }, { chunks: [Buffer.from(PONG)] }])
  try {
    const first = await drain(h.adapter, req([
      { role: 'system', content: text('DSH SYSTEM PROMPT') },
      { role: 'user', content: text('hello') },
    ], { model: 'gemini-3.8-flash', sessionId: main }))
    assert.equal(first, 'PONG\n')
    const second = await drain(h.adapter, req([
      { role: 'user', content: text('hello') }, { role: 'assistant', content: text('PONG') }, { role: 'user', content: text('again') },
    ], { model: 'gemini-3.8-flash', sessionId: main }))
    assert.equal(second, 'PONG\n')
    const [a, b] = h.spawns.map((s) => s.spec.argv)
    const promptA = flag(a, '-p')
    assert.doesNotMatch(promptA, /DSH SYSTEM PROMPT/)
    assert.match(promptA, /hello/)
    assert.deepEqual([flag(a, '--model'), flag(a, '--effort')], ['gemini-3.8-flash', 'high'])
    assert.match(flag(b, '-p'), /^again\n/)
    assert.ok(flag(b, '--conversation'))
    const trace = await h.tools.get('antigravity_trace').execute({ id: main }, { agent: { id: main } })
    assert.equal(trace.summary.current_run.mode, 'native-chat-followup')
    assert.equal(trace.summary.kind, 'chat', 'a main session is never re-classified as a native child by its own trace')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('main chat: AGY tool steps appear as progress lines; DSH gets AGY-reported usage; long-turn ceiling applies', async () => {
  const TOOLS = readFileSync(join(ROOT, 'scripts', 'fixtures', 'agy-1.4.0-tools.ndjson'), 'utf8')
  const { dir, h, main } = setup('agy-chat-progress-', [{ chunks: [Buffer.from(TOOLS)] }])
  try {
    const chunks = []
    for await (const chunk of h.adapter.stream(req([{ role: 'user', content: text('do the steps') }], { model: 'gemini-3.8-flash', sessionId: main }))) chunks.push(chunk)
    const streamed = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    assert.match(streamed, /\n\n> AGY · run_command echo hello-agy — done \(0\.4s\)\n\n/, 'each progress line is its own blockquote paragraph')
    assert.match(streamed, /> AGY · view_file \S*missing\.txt — failed/)
    assert.match(streamed, /> AGY · write_to_file \S*note\.txt — done/)
    assert.match(streamed, /DONE\n$/)
    const usage = chunks.find((c) => c.type === 'usage')
    // Prompt side = the last model call (current context); output = turn total (real agy numbers).
    assert.deepEqual(usage.usage, { inputTokens: 2321, outputTokens: 780, cacheReadTokens: 15612, reasoningTokens: 536 })
    assert.equal(chunks.at(-1).type, 'finish')
    assert.equal(flag(h.spawns[0].spec.argv, '--print-timeout'), '3600s')
    // Settled message: AGY's own text + ONE collapsible GenUI panel instead of the live lines.
    const final = chunks.find((c) => c.type === 'block-end').block.text
    assert.doesNotMatch(final, /> AGY ·/)
    const [before, fence] = final.split('```dsh-ui\n')
    assert.match(before, /DONE\s*$/)
    const body = fence.slice(0, fence.indexOf('\n```'))
    assert.equal(body.includes('\n'), false, 'fence body stays on one line')
    const spec = JSON.parse(body)
    const section = spec.items[0].items[0]
    assert.equal(spec.items[0].type, 'accordion')
    assert.match(section.title, /^AGY 执行过程 · 4 个工具步骤 · 1 个失败 · \d+s · 思考 536 tokens$/)
    const steps = section.items.find((n) => n.type === 'timeline').items
    assert.deepEqual(steps.map((s) => s.title.split(' · ')[0]), ['run_command', 'view_file', 'write_to_file', 'view_file'])
    assert.match(steps[2].title, /^write_to_file · (\S*[\\/])?note\.txt$/)
    assert.match(steps[0].desc, /^完成 — hello-agy/)
    assert.match(steps[1].desc, /^失败 — /)
    assert.equal(steps[0].time, '0.4s')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('execution panel off: the settled message keeps the live progress lines', async () => {
  const TOOLS = readFileSync(join(ROOT, 'scripts', 'fixtures', 'agy-1.4.0-tools.ndjson'), 'utf8')
  const { dir, h, main } = setup('agy-chat-nopanel-', [{ chunks: [Buffer.from(TOOLS)] }], {}, { nativeChatExecutionPanel: false })
  try {
    const chunks = []
    for await (const chunk of h.adapter.stream(req([{ role: 'user', content: text('go') }], { sessionId: main }))) chunks.push(chunk)
    const streamed = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    assert.equal(chunks.find((c) => c.type === 'block-end').block.text, streamed)
    assert.doesNotMatch(streamed, /dsh-ui/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lenient history drops earlier execution panels', () => {
  const panel = '```dsh-ui\n{"items":[{"type":"accordion","items":[]}]}\n```'
  const prompt = nativePrompt(req([
    { role: 'user', content: text('first') },
    { role: 'assistant', content: text('answer\n\n' + panel) },
    { role: 'user', content: text('second') },
  ]), false, { mode: 'lenient' })
  assert.doesNotMatch(prompt, /accordion/)
  assert.match(prompt, /answer\n\n\[AGY execution panel omitted\]/)
})

test('children keep tool steps out of their text (trace only) but still report usage', async () => {
  const TOOLS = readFileSync(join(ROOT, 'scripts', 'fixtures', 'agy-1.4.0-tools.ndjson'), 'utf8')
  const { dir, h } = setup('agy-chat-child-usage-', [{ chunks: [Buffer.from(TOOLS)] }])
  try {
    const child = 'child-usage-0001'
    h.agents.set(child, { id: child, session: { id: child, header: { cwd: dir, origin: 'subagent' } } })
    const chunks = []
    for await (const chunk of h.adapter.stream(req([{ role: 'user', content: text('do the steps') }], { model: 'gemini-3.8-flash', sessionId: child }))) chunks.push(chunk)
    assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'DONE\n')
    assert.equal(chunks.find((c) => c.type === 'usage').usage.outputTokens, 780)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('session-title / compaction calls run one-shot: no --conversation, no registry update, separate trace', async () => {
  const { dir, h, main } = setup('agy-chat-aux-', [{ chunks: [Buffer.from(PONG)] }, { chunks: [Buffer.from(PONG)] }])
  try {
    await drain(h.adapter, req([{ role: 'user', content: text('hello') }], { sessionId: main }))
    const registry = () => JSON.parse(readFileSync(join(dir, 'native.json'), 'utf8'))
    const before = registry()[main]
    const title = await drain(h.adapter, req([
      { role: 'system', content: text('Write a short title for this conversation.') },
      { role: 'user', content: text('hello') },
    ], { sessionId: main, purpose: 'session-title' }))
    assert.equal(title, 'PONG\n')
    const argv = h.spawns[1].spec.argv
    assert.equal(argv.includes('--conversation'), false)
    assert.match(flag(argv, '-p'), /Write a short title/)
    assert.match(flag(argv, '-p'), /Do not use any tools/)
    assert.deepEqual(registry()[main], before)
    const aux = await h.tools.get('antigravity_trace').execute({ id: main + '::session-title' }, { agent: { id: main } })
    assert.equal(aux.summary.current_run.mode, 'session-title')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('image blocks are copied from the DSH attachment store and handed to AGY via --add-dir and a path note', async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  const reads = []
  const attachments = { async readImage(ref) { reads.push(ref.attachmentId); return { ref, data: bytes } } }
  const { dir, h, main } = setup('agy-chat-img-', [{ chunks: [Buffer.from(PONG)] }, { chunks: [Buffer.from(PONG)] }], { attachments })
  let imageDir
  try {
    const image = { type: 'image', attachment: { attachmentId: 'sha-abc', mediaType: 'image/png', bytes: 7, width: 64, height: 32, name: 'shot.png' } }
    await drain(h.adapter, req([{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, image] }], { sessionId: main }))
    const argv = h.spawns[0].spec.argv
    imageDir = flag(argv, '--add-dir')
    assert.ok(imageDir && existsSync(imageDir))
    const prompt = flag(argv, '-p')
    const saved = prompt.match(/saved at (\S+\.png)/)[1]
    assert.ok(saved.startsWith(imageDir))
    assert.deepEqual([...readFileSync(saved)], [...bytes])
    assert.match(prompt, /Attached image "shot\.png" \(64x32, image\/png\)/)
    // A follow-up with the same image reuses the saved file and still adds the directory.
    await drain(h.adapter, req([
      { role: 'user', content: [{ type: 'text', text: 'what is this?' }, image] }, { role: 'assistant', content: text('PONG') },
      { role: 'user', content: [{ type: 'text', text: 'and now?' }, image] },
    ], { sessionId: main }))
    const follow = h.spawns[1].spec.argv
    assert.equal(flag(follow, '--add-dir'), imageDir)
    assert.match(flag(follow, '-p'), /and now\?\n\[Attached image/)
    assert.deepEqual(reads, ['sha-abc'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
    if (imageDir) rmSync(imageDir, { recursive: true, force: true })
  }
})
