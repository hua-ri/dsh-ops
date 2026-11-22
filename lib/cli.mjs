import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = join(homedir(), '.dsh', 'dsh-ops')

export function ensureDataDir() {
  mkdirSync(DATA_DIR, { recursive: true })
  return DATA_DIR
}

export function dataDir() {
  return DATA_DIR
}

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(path, data) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8')
}

export function exec(bin, args, { timeout = 30000, stdin, env } = {}) {
  return new Promise((resolve) => {
    const chunks = []
    const errChunks = []
    let done = false
    let child
    let timer

    const finish = (res) => {
      if (done) return
      done = true
      try { clearTimeout(timer) } catch {}
      resolve(res)
    }

    try {
      child = spawn(bin, args, {
        windowsHide: true,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      finish({ code: -1, stdout: '', stderr: `启动失败：${e?.message ?? e}` })
      return
    }

    if (stdin && child.stdin) {
      child.stdin.write(stdin)
      child.stdin.end()
    }

    timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      finish({
        code: -2,
        stdout: Buffer.concat(chunks).toString('utf8').trim(),
        stderr: `超时 ${Math.round(timeout / 1000)}s`,
      })
    }, timeout)

    child.stdout.on('data', (d) => chunks.push(d))
    child.stderr.on('data', (d) => errChunks.push(d))
    child.on('error', (e) => {
      finish({ code: -1, stdout: '', stderr: String(e?.message ?? e) })
    })
    child.on('close', (code) => {
      finish({
        code: code ?? -1,
        stdout: Buffer.concat(chunks).toString('utf8').trim(),
        stderr: Buffer.concat(errChunks).toString('utf8').trim(),
      })
    })
  })
}

export async function which(bin) {
  const r = await exec('which', [bin], { timeout: 5000 })
  if (r.code === 0 && r.stdout) return r.stdout.split('\n')[0].trim()
  return null
}

export function trimOutput(text, maxLen = 4000) {
  const s = String(text ?? '')
  if (s.length <= maxLen) return s
  return s.slice(0, maxLen) + `\n\n…（全文 ${s.length} 字，已截断前 ${maxLen} 字）`
}
