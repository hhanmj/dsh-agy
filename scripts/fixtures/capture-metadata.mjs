#!/usr/bin/env node
/**
 * Re-capture the REAL, quota-free agy metadata fixtures for the installed CLI:
 *   node scripts/fixtures/capture-metadata.mjs [--dry-run]
 *
 * Runs only commands that never start a model turn: `agy --version`,
 * `agy help`, `agy models`, and `agy models --output-format json` (recorded
 * because it is REJECTED, which is why src/models.ts parses text). Writes
 * agy-<version>-*.txt next to this script and records each file in
 * manifest.json with origin "real-capture". stream-json fixtures are NOT
 * produced here: they need a model turn (quota) and stay hand-sanitized
 * captures (see manifest.json `origin`/`quota`).
 *
 * `agy models` needs network access to Google; like the plugin, the proxy is
 * taken from AGY_PROXY, else the first line of ~/.dsh/agy-proxy.txt.
 * Nothing in the agy configuration or permissions is changed.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const dryRun = process.argv.includes('--dry-run')

function proxyUrl() {
  if (process.env.AGY_PROXY) return process.env.AGY_PROXY
  const file = join(homedir(), '.dsh', 'agy-proxy.txt')
  return existsSync(file) ? (readFileSync(file, 'utf8').split(/\r?\n/)[0] ?? '').trim() : ''
}

const proxy = proxyUrl()
const env = { ...process.env }
if (proxy) for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy']) env[key] = proxy

function run(args, timeoutMs = 90_000) {
  const started = Date.now()
  const r = spawnSync('agy', args, { env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
  return { args, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ms: Date.now() - started, timedOut: r.error?.code === 'ETIMEDOUT' }
}

const version = run(['--version'], 30_000).stdout.trim()
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`cannot read agy version (got ${JSON.stringify(version)})`)
const today = new Date().toISOString().slice(0, 10)

/** name → [args, which stream holds the payload, expected exit] */
const captures = {
  [`agy-${version}-help.txt`]: [['help'], 'stderr', 0],
  [`agy-${version}-models.txt`]: [['models'], 'stdout', 0],
  [`agy-${version}-models-json-rejected.txt`]: [['models', '--output-format', 'json'], 'stderr', 1],
}

const manifestPath = join(HERE, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
for (const [name, [args, stream, expected]] of Object.entries(captures)) {
  const r = run(args)
  const payload = r[stream]
  console.log(`agy ${args.join(' ')} → exit ${r.status} in ${r.ms} ms (${payload.length} chars on ${stream})`)
  if (r.timedOut || r.status !== expected || payload.length === 0) {
    throw new Error(`agy ${args.join(' ')}: unexpected exit ${r.status}${r.timedOut ? ' (timeout; proxy?)' : ''}: ${r.stderr.slice(0, 400)}`)
  }
  if (dryRun) continue
  writeFileSync(join(HERE, name), payload)
  manifest.fixtures[name] = {
    agyVersion: version,
    origin: 'real-capture',
    command: `agy ${args.join(' ')}`,
    stream,
    exitCode: r.status,
    quota: false,
    captured: today,
    sanitized: 'none needed (no account, path or conversation data)',
  }
}
if (!dryRun) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
