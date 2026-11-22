import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export function parseSshConfig(text) {
  const hosts = []
  let current = null

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    const hostMatch = line.match(/^Host\s+(.+)/i)
    if (hostMatch) {
      if (current && current.name) hosts.push(current)
      const name = hostMatch[1].trim()
      if (name.includes('*') || name.includes('?')) {
        current = null
        continue
      }
      current = { name, hostname: null, user: null, port: 22, identityFile: null, proxyJump: null }
      continue
    }

    if (!current) continue

    const kv = line.match(/^(\S+)\s+(.+)/)
    if (!kv) continue
    const [, key, value] = kv
    const k = key.toLowerCase()

    if (k === 'hostname') current.hostname = value
    else if (k === 'user') current.user = value
    else if (k === 'port') current.port = parseInt(value, 10) || 22
    else if (k === 'identityfile') current.identityFile = value.replace(/^~/, homedir())
    else if (k === 'proxyjump') current.proxyJump = value
  }

  if (current && current.name) hosts.push(current)

  return hosts.filter(h => h.hostname)
}

export function readSshConfig() {
  const configPath = join(homedir(), '.ssh', 'config')
  try {
    const text = readFileSync(configPath, 'utf8')
    return { ok: true, hosts: parseSshConfig(text), path: configPath }
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, error: '未找到 ~/.ssh/config 文件' }
    return { ok: false, error: e.message }
  }
}
