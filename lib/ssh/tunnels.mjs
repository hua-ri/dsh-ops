import { spawn } from 'node:child_process'
import { buildSshArgs, findHost } from './hosts.mjs'

const tunnels = new Map()
let nextId = 1

export function createTunnel({ hostName, type, localPort, remoteHost, remotePort }) {
  const host = findHost(hostName)
  if (!host) return { ok: false, error: `未找到主机 ${hostName}` }

  let sshArgs, target

  if (host.relay) {
    const relayHost = findHost(host.relay)
    if (!relayHost) return { ok: false, error: `未找到中继主机 ${host.relay}` }
    const relay = buildSshArgs(relayHost)
    sshArgs = relay.args
    target = relay.target
    const fwdTarget = host.hostname
    sshArgs.push('-N')
    if (type === 'local') {
      sshArgs.push('-L', `${localPort}:${fwdTarget}:${remotePort}`)
    } else if (type === 'remote') {
      sshArgs.push('-R', `${remotePort}:${remoteHost || '127.0.0.1'}:${localPort}`)
    } else if (type === 'dynamic') {
      sshArgs.push('-D', String(localPort))
    } else {
      return { ok: false, error: `未知隧道类型 ${type}` }
    }
  } else {
    const built = buildSshArgs(host)
    sshArgs = built.args
    target = built.target
    sshArgs.push('-N')
    if (type === 'local') {
      sshArgs.push('-L', `${localPort}:${remoteHost || '127.0.0.1'}:${remotePort}`)
    } else if (type === 'remote') {
      sshArgs.push('-R', `${remotePort}:${remoteHost || '127.0.0.1'}:${localPort}`)
    } else if (type === 'dynamic') {
      sshArgs.push('-D', String(localPort))
    } else {
      return { ok: false, error: `未知隧道类型 ${type}` }
    }
  }

  sshArgs.push(target)

  const proc = spawn('ssh', sshArgs, { stdio: 'pipe', detached: false })
  const id = 't' + (nextId++)
  const tunnel = {
    id, host: hostName, type,
    localPort: Number(localPort),
    remoteHost: remoteHost || '127.0.0.1',
    remotePort: Number(remotePort) || 0,
    pid: proc.pid,
    startedAt: new Date().toISOString(),
    alive: true,
    error: null,
  }
  tunnels.set(id, { ...tunnel, proc })

  proc.on('exit', (code) => {
    const t = tunnels.get(id)
    if (t) { t.alive = false; t.error = code !== 0 ? `exit ${code}` : null }
  })

  proc.on('error', (e) => {
    const t = tunnels.get(id)
    if (t) { t.alive = false; t.error = e.message }
  })

  let stderr = ''
  proc.stderr?.on('data', (d) => { stderr += d.toString(); if (stderr.length > 2000) stderr = stderr.slice(-1000) })

  return { ok: true, tunnel: { ...tunnel } }
}

export function listTunnels() {
  const result = []
  for (const [id, t] of tunnels) {
    try { process.kill(t.proc.pid, 0); t.alive = true } catch { t.alive = false }
    result.push({
      id, host: t.host, type: t.type,
      localPort: t.localPort, remoteHost: t.remoteHost, remotePort: t.remotePort,
      pid: t.pid, startedAt: t.startedAt, alive: t.alive, error: t.error,
    })
  }
  return result
}

export function closeTunnel(id) {
  const t = tunnels.get(id)
  if (!t) return { ok: false, error: `隧道 ${id} 不存在` }
  try { process.kill(t.proc.pid, 'SIGTERM') } catch {}
  tunnels.delete(id)
  return { ok: true }
}
