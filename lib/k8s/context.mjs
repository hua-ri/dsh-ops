import { readJson, writeJson, dataDir, exec } from '../cli.mjs'
import { join } from 'node:path'
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'

const contextsFile = () => join(dataDir(), 'k8s', 'contexts.json')

export function loadContexts() {
  return readJson(contextsFile(), [])
}

export function saveContexts(contexts) {
  const dir = join(dataDir(), 'k8s')
  mkdirSync(dir, { recursive: true })
  writeJson(contextsFile(), contexts)
}

export function findContext(name) {
  const contexts = loadContexts()
  return contexts.find((c) => c.name === name) || null
}

function credDir(name) {
  const dir = join(dataDir(), 'k8s', 'creds', name)
  mkdirSync(dir, { recursive: true })
  return dir
}

function saveCredFile(ctxName, filename, content) {
  const dir = credDir(ctxName)
  const p = join(dir, filename)
  writeFileSync(p, content, { mode: 0o600 })
  return p
}

function removeCredFiles(ctxName) {
  const dir = join(dataDir(), 'k8s', 'creds', ctxName)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

export function addContext({ name, kubeconfig, context, namespace, server, token, caData, certData, keyData, source, tags, note }) {
  const contexts = loadContexts()
  if (contexts.find((c) => c.name === name)) {
    return { ok: false, why: `上下文 ${name} 已存在` }
  }

  const entry = {
    name,
    source: source || 'kubeconfig',
    kubeconfig: null,
    context: context || null,
    server: server || null,
    namespace: namespace || 'default',
    tags: tags || [],
    note: note || '',
    addedAt: new Date().toISOString(),
  }

  if (source === 'token') {
    entry.server = server
    if (token) saveCredFile(name, 'token', token)
    if (caData) saveCredFile(name, 'ca.pem', caData)
  } else if (source === 'cert') {
    entry.server = server
    if (caData) saveCredFile(name, 'ca.pem', caData)
    if (certData) saveCredFile(name, 'client.pem', certData)
    if (keyData) saveCredFile(name, 'client-key.pem', keyData)
  } else {
    entry.kubeconfig = kubeconfig || join(homedir(), '.kube', 'config')
    entry.context = context || name
  }

  contexts.push(entry)
  saveContexts(contexts)
  return { ok: true }
}

export function removeContext(name) {
  const contexts = loadContexts()
  const idx = contexts.findIndex((c) => c.name === name)
  if (idx === -1) return { ok: false, why: `上下文 ${name} 不存在` }
  contexts.splice(idx, 1)
  saveContexts(contexts)
  removeCredFiles(name)
  return { ok: true }
}

export function updateContext(name, patch) {
  const contexts = loadContexts()
  const c = contexts.find((c) => c.name === name)
  if (!c) return { ok: false, why: `上下文 ${name} 不存在` }
  if (patch.namespace !== undefined) c.namespace = patch.namespace
  if (patch.tags !== undefined) c.tags = patch.tags
  if (patch.note !== undefined) c.note = patch.note
  saveContexts(contexts)
  return { ok: true }
}

export function buildKubectlArgs(context, extraArgs = []) {
  const args = []
  const src = context.source || 'kubeconfig'
  const cDir = join(dataDir(), 'k8s', 'creds', context.name)

  if (src === 'token') {
    args.push('--server', context.server)
    const tokenFile = join(cDir, 'token')
    if (existsSync(tokenFile)) {
      const tk = readFileSync(tokenFile, 'utf8').trim()
      args.push('--token', tk)
    }
    const caFile = join(cDir, 'ca.pem')
    if (existsSync(caFile)) args.push('--certificate-authority', caFile)
    else args.push('--insecure-skip-tls-verify=true')
  } else if (src === 'cert') {
    args.push('--server', context.server)
    const caFile = join(cDir, 'ca.pem')
    if (existsSync(caFile)) args.push('--certificate-authority', caFile)
    const certFile = join(cDir, 'client.pem')
    if (existsSync(certFile)) args.push('--client-certificate', certFile)
    const keyFile = join(cDir, 'client-key.pem')
    if (existsSync(keyFile)) args.push('--client-key', keyFile)
  } else {
    if (context.kubeconfig) args.push('--kubeconfig', context.kubeconfig)
    if (context.context) args.push('--context', context.context)
  }

  args.push(...extraArgs)
  return args
}

export async function parseKubeconfig(pathOrContent) {
  let filePath = pathOrContent
  let tmpPath = null

  if (pathOrContent.includes('\n') || pathOrContent.includes('apiVersion')) {
    tmpPath = join(tmpdir(), `dsh-ops-kc-${Date.now()}.yaml`)
    writeFileSync(tmpPath, pathOrContent, 'utf8')
    filePath = tmpPath
  }

  try {
    const r = await exec('kubectl', ['config', 'view', '--kubeconfig', filePath, '--raw', '-o', 'json'], { timeout: 10000 })
    if (r.code !== 0) return { ok: false, error: r.stderr || `kubectl config view 失败 (exit ${r.code})` }
    const cfg = JSON.parse(r.stdout)
    const clusters = (cfg.clusters || []).map(c => ({ name: c.name, server: c.cluster?.server || '', caData: c.cluster?.['certificate-authority-data'] || '' }))
    const users = (cfg.users || []).map(u => ({ name: u.name, token: u.user?.token || '', certData: u.user?.['client-certificate-data'] || '', keyData: u.user?.['client-key-data'] || '' }))
    const contexts = (cfg.contexts || []).map(c => ({
      name: c.name,
      cluster: c.context?.cluster || '',
      user: c.context?.user || '',
      namespace: c.context?.namespace || 'default',
    }))
    return { ok: true, contexts, clusters, users, currentContext: cfg['current-context'] || '' }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  } finally {
    if (tmpPath) try { unlinkSync(tmpPath) } catch {}
  }
}

export function importContexts(parsed, selectedNames, kubeconfigPath) {
  const results = []
  for (const ctxInfo of parsed.contexts) {
    if (!selectedNames.includes(ctxInfo.name)) continue
    const existing = findContext(ctxInfo.name)
    if (existing) { results.push({ name: ctxInfo.name, ok: false, why: '已存在' }); continue }

    const r = addContext({
      name: ctxInfo.name,
      kubeconfig: kubeconfigPath || join(homedir(), '.kube', 'config'),
      context: ctxInfo.name,
      namespace: ctxInfo.namespace || 'default',
      source: 'kubeconfig',
    })
    results.push({ name: ctxInfo.name, ...r })
  }
  return results
}
