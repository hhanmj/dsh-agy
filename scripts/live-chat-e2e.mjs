#!/usr/bin/env node
/**
 * OPT-IN live check of AGY as the model of a MAIN DSH session (spends a little AGY quota):
 *   node scripts/live-chat-e2e.mjs [--keep]
 *
 * Drives the BUILT plugin with the real Antigravity CLI in throwaway
 * directories: a main session (not a child) picks gemini-3.8-flash, sends a
 * DSH-style system prompt plus an image attachment, continues the
 * conversation, and asks for a session title (one-shot, outside the
 * conversation). Uses a minimal Node subprocess shim and a fake attachment
 * store, not the DSH runtime.
 */
import { deflateSync } from 'node:zlib'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { apply, Config } = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href)
const { subprocess } = await import(pathToFileURL(join(ROOT, 'scripts/helpers/node-subprocess.mjs')).href)

function crc32(buf) { let crc = 0xffffffff; for (const byte of buf) { crc ^= byte; for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1 } return (crc ^ 0xffffffff) >>> 0 }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]) }
/** 64x64 PNG: left half red, right half blue. */
function splitPng() {
  const w = 64, h = 64, raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; const left = x < w / 2; raw[o] = left ? 220 : 20; raw[o + 1] = left ? 20 : 40; raw[o + 2] = left ? 20 : 220 }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const workspace = mkdtempSync(join(tmpdir(), 'agy-chat-ws-'))
const state = mkdtempSync(join(tmpdir(), 'agy-chat-state-'))
const png = splitPng()
const tools = new Map()
let provider
let adapter
const main = 'live-main-session-' + Date.now().toString(36)
const agents = new Map([[main, { id: main, session: { id: main, header: { cwd: workspace } } }]])
const attachments = { async readImage(ref) { return { ref, data: png } } }
const ctx = {
  effect(fn) { return fn() },
  subagents: { registerProvider(p) { provider = p; return () => {} }, getProvider() { return provider } },
  subprocess,
  llm: { registerAdapter(_routes, value) { adapter = value; return () => {} } },
  agents: { get(id) { return agents.get(id) } },
  tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
  logger: { info: (m) => console.log('[plugin]', m), warn: (m) => console.warn('[plugin:warn]', m) },
  get(name) { return name === 'attachments' ? attachments : undefined },
}
apply(ctx, Config({
  nativeContinuableEnabled: true,
  evidenceDir: join(state, 'evidence'), registryPath: join(state, 'registry.json'), nativeRegistryPath: join(state, 'native.json'),
  traceDir: join(state, 'traces'), printTimeoutMs: 180_000,
}))

let failures = 0
const ok = (cond, label) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + label); if (!cond) failures += 1 }
async function ask(messages, extra = {}) {
  let final = ''
  for await (const c of adapter.stream({ provider: 'agy-native-cli', model: 'gemini-3.8-flash', sessionId: main, messages, ...extra })) if (c.type === 'block-end') final = c.block.text
  return final
}
const image = { type: 'image', attachment: { attachmentId: 'live-split-png', mediaType: 'image/png', bytes: png.length, width: 64, height: 64, name: 'split.png' } }
let imageDir
try {
  const listed = await adapter.listModels('agy-native-cli')
  ok(listed.every((m) => m.inputModalities.includes('image')), 'models declare image input')
  const q1 = [
    { role: 'system', content: [{ type: 'text', text: 'You are DSH. Use run_code and other DSH host tools.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Look at the attached image and answer in one line exactly: LEFT=<color of left half> RIGHT=<color of right half>' }, image] },
  ]
  const a1 = await ask(q1)
  console.log('turn 1:', JSON.stringify(a1))
  ok(/LEFT=\s*red/i.test(a1) && /RIGHT=\s*blue/i.test(a1), 'AGY read the attached image through its own viewer')
  const a2 = await ask([...q1, { role: 'assistant', content: [{ type: 'text', text: a1 }] }, { role: 'user', content: [{ type: 'text', text: 'Reply with exactly the single word PONG2. Do not use any tools.' }] }])
  console.log('turn 2:', JSON.stringify(a2))
  ok(/PONG2/.test(a2), 'main session continued its AGY conversation')
  const registry = JSON.parse(readFileSync(join(state, 'native.json'), 'utf8'))
  const title = await ask([
    { role: 'system', content: [{ type: 'text', text: 'Generate a concise title (at most 6 words) for this conversation. Reply with the title only.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Look at the attached image and tell me the colors.' }] },
  ], { purpose: 'session-title' })
  console.log('title:', JSON.stringify(title))
  ok(title.trim().length > 0 && title.length < 120, 'session-title produced a short title')
  ok(JSON.stringify(JSON.parse(readFileSync(join(state, 'native.json'), 'utf8'))) === JSON.stringify(registry), 'title call did not touch the session AGY conversation')
  const trace = await tools.get('antigravity_trace').execute({ id: main, limit: 200 }, { agent: { id: main } })
  console.log(tools.get('antigravity_trace').output.render({}, trace)[0].text)
  ok(trace.summary.kind === 'chat' && trace.summary.runs === 2, 'main session trace: kind chat, two conversation runs')
  const viewed = trace.events.find((e) => e.type === 'tool_call' && e.tool === 'view_file')
  imageDir = viewed ? dirname(String(viewed.parameters.AbsolutePath)) : undefined
  ok(viewed !== undefined, 'AGY opened the image with view_file')
} finally {
  console.log('workspace: ' + workspace + '\nstate: ' + state)
  if (!process.argv.includes('--keep')) {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  }
}
console.log(failures === 0 ? '\nLIVE CHAT E2E: all checks passed' : '\nLIVE CHAT E2E: ' + failures + ' check(s) failed')
process.exit(failures === 0 ? 0 : 1)
