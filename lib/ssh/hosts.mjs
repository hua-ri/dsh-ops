import { readJson, writeJson, dataDir } from '../cli.mjs'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const hostsFile = () => join(dataDir(), 'ssh', 'hosts.json')

export function loadHosts() {
  return readJson(hostsFile(), [])
}

export function saveHosts(hosts) {
  const dir = join(dataDir(), 'ssh')
  mkdirSync(dir, { recursive: true })
  writeJson(hostsFile(), hosts)
}

export function findHost(nameOrAlias) {
  const hosts = loadHosts()
  return hosts.find((h) => h.name === nameOrAlias) || null
}

export function addHost({ name, hostname, port, user, identityFile, proxyJump, relay, tags, note }) {
  const hosts = loadHosts()
  if (hosts.find((h) => h.name === name)) {
    return { ok: false, why: `主机 ${name} 已存在` }
  }
  hosts.push({
    name,
    hostname,
    port: port || 22,
    user: user || process.env.USER || '',
    identityFile: identityFile || null,
    proxyJump: proxyJump || null,
    relay: relay || null,
    tags: tags || [],
    note: note || '',
    addedAt: new Date().toISOString(),
  })
  saveHosts(hosts)
  return { ok: true }
}

export function removeHost(name) {
  const hosts = loadHosts()
  const idx = hosts.findIndex((h) => h.name === name)
  if (idx === -1) return { ok: false, why: `主机 ${name} 不存在` }
  hosts.splice(idx, 1)
  saveHosts(hosts)
  return { ok: true }
}

export function updateHost(name, patch) {
  const hosts = loadHosts()
  const h = hosts.find((h) => h.name === name)
  if (!h) return { ok: false, why: `主机 ${name} 不存在` }
  if (patch.hostname !== undefined) h.hostname = patch.hostname
  if (patch.port !== undefined) h.port = patch.port
  if (patch.user !== undefined) h.user = patch.user
  if (patch.identityFile !== undefined) h.identityFile = patch.identityFile
  if (patch.proxyJump !== undefined) h.proxyJump = patch.proxyJump
  if (patch.relay !== undefined) h.relay = patch.relay
  if (patch.tags !== undefined) h.tags = patch.tags
  if (patch.note !== undefined) h.note = patch.note
  saveHosts(hosts)
  return { ok: true }
}

export function buildSshArgs(host, extraArgs = []) {
  const args = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes']
  if (host.port && host.port !== 22) args.push('-p', String(host.port))
  if (host.identityFile) args.push('-i', host.identityFile)
  if (host.proxyJump) args.push('-J', host.proxyJump)
  args.push(...extraArgs)
  const target = host.user ? `${host.user}@${host.hostname}` : host.hostname
  return { args, target }
}

function shellQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

export function buildRelayCommand(host, command) {
  if (!host.relay) return null
  const relayHost = findHost(host.relay)
  if (!relayHost) return null
  const { args: relayArgs, target: relayTarget } = buildSshArgs(relayHost)
  const innerParts = ['ssh', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes']
  if (host.port && host.port !== 22) innerParts.push('-p', String(host.port))
  if (host.identityFile) innerParts.push('-i', host.identityFile)
  const innerTarget = host.user ? `${host.user}@${host.hostname}` : host.hostname
  innerParts.push(innerTarget, shellQuote(command))
  relayArgs.push(relayTarget, innerParts.join(' '))
  return { args: relayArgs, isRelay: true }
}
