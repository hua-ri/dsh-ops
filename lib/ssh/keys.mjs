import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { exec } from '../cli.mjs'

const SSH_DIR = join(homedir(), '.ssh')

export async function listKeys() {
  const keys = []
  let entries
  try { entries = readdirSync(SSH_DIR) } catch { return keys }

  const privNames = entries.filter(n =>
    n.startsWith('id_') && !n.endsWith('.pub')
  )

  for (const name of privNames) {
    const privPath = join(SSH_DIR, name)
    const pubPath = privPath + '.pub'
    let hasPublic = false
    try { statSync(pubPath); hasPublic = true } catch {}

    let fingerprint = ''
    let type = ''
    let comment = ''
    try {
      const r = await exec('ssh-keygen', ['-lf', privPath], { timeout: 5000 })
      if (r.code === 0) {
        const line = r.stdout.trim()
        const parts = line.split(/\s+/)
        fingerprint = parts[1] || ''
        const typeMatch = line.match(/\((\w+)\)/)
        type = typeMatch ? typeMatch[1] : ''
        const commentMatch = line.match(/^\d+\s+\S+\s+(.+?)\s+\(\w+\)$/)
        comment = commentMatch ? commentMatch[1] : ''
      }
    } catch {}

    keys.push({ name, path: privPath, type, hasPublic, fingerprint, comment })
  }
  return keys
}

export async function generateKey({ type = 'ed25519', bits, comment, path }) {
  const keyPath = path || join(SSH_DIR, `id_${type}`)
  const args = ['-t', type, '-f', keyPath, '-N', '']
  if (bits && (type === 'rsa')) args.push('-b', String(bits))
  if (comment) args.push('-C', comment)
  else args.push('-C', `${process.env.USER || 'user'}@dsh-ops`)

  const r = await exec('ssh-keygen', args, { timeout: 15000 })
  if (r.code !== 0) return { ok: false, error: r.stderr || `exit ${r.code}` }

  let fingerprint = ''
  try {
    const fp = await exec('ssh-keygen', ['-lf', keyPath], { timeout: 5000 })
    if (fp.code === 0) fingerprint = fp.stdout.trim().split(/\s+/)[1] || ''
  } catch {}

  return { ok: true, path: keyPath, fingerprint }
}

export function deleteKey(name) {
  if (!name.startsWith('id_') || name.includes('/') || name.includes('..')) {
    return { ok: false, error: '无效的密钥名称' }
  }
  const privPath = join(SSH_DIR, name)
  const pubPath = privPath + '.pub'
  let deleted = []
  try { unlinkSync(privPath); deleted.push(name) } catch (e) {
    if (e.code !== 'ENOENT') return { ok: false, error: e.message }
  }
  try { unlinkSync(pubPath); deleted.push(name + '.pub') } catch {}
  if (!deleted.length) return { ok: false, error: '密钥文件不存在' }
  return { ok: true, deleted }
}
