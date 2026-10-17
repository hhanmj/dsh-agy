/** Minimal real Node subprocess seam for OPT-IN live scripts (stands in for DSH's ctx.subprocess). */
import { spawn as nodeSpawn, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

function collector() {
  let text = ''
  return { push: (chunk) => { text += chunk.toString('utf8') }, reader: { readFrom: (from) => ({ text: text.slice(from), nextOffset: Buffer.byteLength(text), lossy: false }) } }
}

export const subprocess = {
  async resolveExecutable(command, env = {}) {
    if (isAbsolute(command)) {
      if (existsSync(command)) return command
      throw new Error('not found: ' + command)
    }
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
    for (const dir of String(env.PATH ?? env.Path ?? process.env.PATH ?? '').split(delimiter)) {
      for (const ext of exts) {
        const candidate = join(dir, command + ext)
        if (dir && existsSync(candidate)) return candidate
      }
    }
    throw new Error('not found on PATH: ' + command)
  },
  spawn(spec) {
    const child = nodeSpawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    const out = spec.stdio.stdout === 'pipe' ? undefined : collector()
    const err = collector()
    if (out) child.stdout.on('data', out.push)
    child.stderr.on('data', err.push)
    const done = new Promise((resolve, reject) => {
      child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))
      child.on('error', reject)
    })
    let terminated = false
    const terminate = () => {
      if (terminated || child.exitCode !== null) return
      terminated = true
      if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {})
      else child.kill('SIGTERM')
    }
    spec.signal?.addEventListener('abort', terminate, { once: true })
    return {
      stdin: undefined, stderr: undefined, control: undefined,
      stdout: out ? undefined : child.stdout,
      collected: { stderr: err.reader, ...(out ? { stdout: out.reader } : {}) },
      done, terminate,
      async waitForExit() { await done.catch(() => {}); return true },
    }
  },
}
