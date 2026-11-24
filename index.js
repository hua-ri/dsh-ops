let defineTool = null
try {
  ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
} catch {}

import { readJson, writeJson, dataDir, ensureDataDir, which, exec, trimOutput } from './lib/cli.mjs'
import { join } from 'node:path'
import { mkdirSync, readdirSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'

import { loadHosts, findHost, addHost, removeHost, updateHost, buildSshArgs, buildRelayCommand } from './lib/ssh/hosts.mjs'
import { readSshConfig } from './lib/ssh/config.mjs'
import { substituteVars, extractVars } from './lib/ssh/snippet-vars.mjs'
import { listKeys, generateKey, deleteKey } from './lib/ssh/keys.mjs'
import { createTunnel, listTunnels, closeTunnel } from './lib/ssh/tunnels.mjs'
import { loadContexts, findContext, addContext, removeContext, updateContext, buildKubectlArgs, parseKubeconfig, importContexts } from './lib/k8s/context.mjs'

const name = 'dsh-ops'
const inject = ['webServer']

const DEFAULT_CONFIG = {
  ssh: { enabled: true },
  k8s: { enabled: true },
}

function configPath() { return join(dataDir(), 'config.json') }
function loadModuleConfig() { return readJson(configPath(), DEFAULT_CONFIG) }
function saveModuleConfig(cfg) { ensureDataDir(); writeJson(configPath(), cfg) }

function snippetsPath() { return join(dataDir(), 'ssh', 'snippets.json') }
function loadSnippets() { return readJson(snippetsPath(), []) }
function saveSnippets(list) {
  mkdirSync(join(dataDir(), 'ssh'), { recursive: true })
  writeJson(snippetsPath(), list)
}

let registeredToolCount = 0

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

async function jsonBody(req) {
  return JSON.parse(await readBody(req))
}

function ok(res, data) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(data))
}

function err(res, status, msg) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: msg }))
}

async function sshExec(host, command, opts = {}) {
  const relay = buildRelayCommand(host, command)
  if (relay) return exec('ssh', relay.args, { timeout: opts.timeout || 30000, stdin: opts.stdin })
  const { args, target } = buildSshArgs(host)
  args.push(target, command)
  return exec('ssh', args, { timeout: opts.timeout || 30000, stdin: opts.stdin })
}

async function apply(ctx) {
  const toolsSvc = (() => { try { return ctx.get?.('tools') } catch { return null } })()
  const cfg = loadModuleConfig()

  if (defineTool && toolsSvc?.register) {
    if (cfg.ssh?.enabled !== false) {
      const { registerSSHTools } = await import('./lib/ssh/mod.mjs')
      registerSSHTools(ctx, defineTool, toolsSvc, cfg.ssh)
      registeredToolCount += 17
    }
    if (cfg.k8s?.enabled !== false) {
      const { registerK8sTools } = await import('./lib/k8s/mod.mjs')
      registerK8sTools(ctx, defineTool, toolsSvc, cfg.k8s)
      registeredToolCount += 12
    }
    if (cfg.k8s?.enabled !== false) {
      const { registerHelmTools } = await import('./lib/helm/mod.mjs')
      registerHelmTools(ctx, defineTool, toolsSvc, cfg.k8s)
      registeredToolCount += 10
    }
  }

  const ROUTE = '/api/dsh-ops'

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const path = url.pathname.slice(ROUTE.length)
      const method = req.method

      try {
        // ───── General ─────
        if (method === 'GET' && path === '/status') {
          const deps = {}
          for (const bin of ['ssh', 'kubectl', 'helm']) {
            const p = await which(bin)
            deps[bin] = { ok: !!p, path: p || null }
          }
          return ok(res, {
            config: loadModuleConfig(),
            deps,
            toolCount: registeredToolCount,
            hostCount: loadHosts().length,
            contextCount: loadContexts().length,
          })
        }

        if (method === 'POST' && path === '/config') {
          const body = await jsonBody(req)
          const cfg = loadModuleConfig()
          if (body.module && typeof body.enabled === 'boolean') {
            if (cfg[body.module]) cfg[body.module].enabled = body.enabled
            else cfg[body.module] = { enabled: body.enabled }
            saveModuleConfig(cfg)
          }
          return ok(res, { ok: true, config: cfg })
        }

        // ───── SSH Hosts ─────
        if (method === 'GET' && path === '/ssh/hosts') {
          return ok(res, loadHosts())
        }

        if (method === 'POST' && path === '/ssh/hosts') {
          const body = await jsonBody(req)
          const r = addHost({
            name: body.name, hostname: body.hostname,
            port: body.port, user: body.user,
            identityFile: body.identity_file || body.identityFile,
            proxyJump: body.proxyJump || body.proxy_jump || null,
            relay: body.relay || null,
            tags: body.tags, note: body.note,
          })
          if (!r.ok) return err(res, 400, r.why)
          return ok(res, { ok: true, hosts: loadHosts() })
        }

        const hostMatch = path.match(/^\/ssh\/hosts\/([^/]+)$/)
        if (hostMatch) {
          const hostName = decodeURIComponent(hostMatch[1])
          if (method === 'PUT') {
            const body = await jsonBody(req)
            const r = updateHost(hostName, body)
            if (!r.ok) return err(res, 400, r.why)
            return ok(res, { ok: true, hosts: loadHosts() })
          }
          if (method === 'DELETE') {
            const r = removeHost(hostName)
            if (!r.ok) return err(res, 400, r.why)
            return ok(res, { ok: true, hosts: loadHosts() })
          }
        }

        const hostTestMatch = path.match(/^\/ssh\/hosts\/([^/]+)\/test$/)
        if (method === 'POST' && hostTestMatch) {
          const h = findHost(decodeURIComponent(hostTestMatch[1]))
          if (!h) return err(res, 404, '主机不存在')
          const r = await sshExec(h, 'uname -a', { timeout: 15000 })
          return ok(res, { ok: r.code === 0, code: r.code, stdout: r.stdout, stderr: r.stderr })
        }

        const hostPingMatch = path.match(/^\/ssh\/hosts\/([^/]+)\/ping$/)
        if (method === 'POST' && hostPingMatch) {
          const h = findHost(decodeURIComponent(hostPingMatch[1]))
          if (!h) return err(res, 404, '主机不存在')
          const t0 = Date.now()
          const r = await sshExec(h, 'echo ok', { timeout: 10000 })
          const latencyMs = Date.now() - t0
          return ok(res, { ok: r.code === 0, latencyMs, code: r.code })
        }

        const hostStatsMatch = path.match(/^\/ssh\/hosts\/([^/]+)\/stats$/)
        if (method === 'POST' && hostStatsMatch) {
          const h = findHost(decodeURIComponent(hostStatsMatch[1]))
          if (!h) return err(res, 404, '主机不存在')
          const cmd = [
            'C1=$(grep "^cpu" /proc/stat)',
            'sleep 1',
            'C2=$(grep "^cpu" /proc/stat)',
            'echo "===CPU1===" && echo "$C1"',
            'echo "===CPU2===" && echo "$C2"',
            'echo "===LOAD===" && cat /proc/loadavg',
            'echo "===MEM===" && grep -E "^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):" /proc/meminfo',
            'echo "===DISK===" && df -P -k 2>/dev/null | tail -n+2',
            'echo "===PCOUNT===" && echo "$(ps -e --no-headers 2>/dev/null | wc -l) $(ps -eo nlwp --no-headers 2>/dev/null | awk \'{s+=$1}END{print s}\')"',
            'echo "===PROC===" && ps -eo pid,user:15,%cpu,%mem,nlwp,comm --sort=-%cpu --no-headers 2>/dev/null | head -15',
          ].join(' && ')
          const r = await sshExec(h, cmd, { timeout: 15000 })
          if (r.code !== 0) return ok(res, { ok: false, error: r.stderr || `exit ${r.code}` })

          const out = r.stdout
          const section = (tag) => {
            const re = new RegExp('===' + tag + '===\\n([\\s\\S]*?)(?====\\w|$)')
            const m = out.match(re)
            return m ? m[1].trim() : ''
          }

          const parseCpuLines = (text) => {
            const result = {}
            for (const line of text.split('\n')) {
              const p = line.trim().split(/\s+/)
              if (p.length < 5) continue
              const id = p[0] === 'cpu' ? 'all' : p[0].replace('cpu', '')
              const nums = p.slice(1).map(Number)
              result[id] = nums
            }
            return result
          }

          const cpu1 = parseCpuLines(section('CPU1'))
          const cpu2 = parseCpuLines(section('CPU2'))
          const cores = []
          let overall = 0
          for (const id of Object.keys(cpu2)) {
            const a = cpu1[id], b = cpu2[id]
            if (!a || !b) continue
            const totalA = a.reduce((s, v) => s + v, 0), totalB = b.reduce((s, v) => s + v, 0)
            const idleA = a[3] + (a[4] || 0), idleB = b[3] + (b[4] || 0)
            const dt = totalB - totalA, di = idleB - idleA
            const usage = dt > 0 ? Math.round((1 - di / dt) * 1000) / 10 : 0
            if (id === 'all') overall = usage
            else cores.push({ id: Number(id), usage })
          }

          const loadParts = section('LOAD').split(/\s+/)
          const load = { '1m': Number(loadParts[0]) || 0, '5m': Number(loadParts[1]) || 0, '15m': Number(loadParts[2]) || 0 }

          const memLines = section('MEM').split('\n')
          const mem = {}
          for (const l of memLines) {
            const m = l.match(/^(\w+):\s+(\d+)\s+kB/)
            if (m) mem[m[1]] = Math.round(Number(m[2]) / 1024)
          }
          const memory = {
            total: mem.MemTotal || 0, available: mem.MemAvailable || mem.MemFree || 0,
            buffers: mem.Buffers || 0, cached: mem.Cached || 0,
            swapTotal: mem.SwapTotal || 0, swapFree: mem.SwapFree || 0, unit: 'MB',
          }

          const disk = section('DISK').split('\n').filter(Boolean).map(l => {
            const p = l.trim().split(/\s+/)
            return { fs: p[0], size: Number(p[1]) || 0, used: Number(p[2]) || 0, avail: Number(p[3]) || 0, mount: p[5] || p[4] || '' }
          })

          const procLines = section('PROC').split('\n').filter(Boolean)
          const top = procLines.map(l => {
            const p = l.trim().split(/\s+/)
            const threads = Number(p[4]) || 1
            return { pid: Number(p[0]), user: p[1], cpu: Number(p[2]) || 0, mem: Number(p[3]) || 0, threads, command: p.slice(5).join(' ') }
          })

          const pcountParts = section('PCOUNT').trim().split(/\s+/)
          const totalProcs = Number(pcountParts[0]) || procLines.length
          const totalThreads = Number(pcountParts[1]) || 0

          return ok(res, {
            ok: true,
            cpu: { overall, cores },
            load, memory, disk,
            processes: { total: totalProcs, threads: totalThreads },
            top,
          })
        }

        if (method === 'GET' && path === '/ssh/import-preview') {
          const result = readSshConfig()
          if (!result.ok) return ok(res, { ok: false, error: result.error })
          const existing = loadHosts().map(h => h.name)
          const hosts = result.hosts.map(h => ({ ...h, exists: existing.includes(h.name) }))
          return ok(res, { ok: true, hosts, path: result.path })
        }

        if (method === 'POST' && path === '/ssh/import') {
          const body = await jsonBody(req)
          if (!Array.isArray(body.hosts) || !body.hosts.length) return err(res, 400, '未选择主机')
          const result = readSshConfig()
          if (!result.ok) return ok(res, { ok: false, error: result.error })
          const imported = [], skipped = []
          for (const name of body.hosts) {
            const parsed = result.hosts.find(h => h.name === name)
            if (!parsed) { skipped.push({ name, reason: 'config 中不存在' }); continue }
            const r = addHost({ name: parsed.name, hostname: parsed.hostname, port: parsed.port, user: parsed.user, identityFile: parsed.identityFile, proxyJump: parsed.proxyJump, tags: body.tags || [], note: '' })
            if (r.ok) imported.push(name)
            else skipped.push({ name, reason: r.why })
          }
          return ok(res, { ok: true, imported, skipped, hosts: loadHosts() })
        }

        // ───── SSH Exec ─────
        if (method === 'POST' && path === '/ssh/exec') {
          const body = await jsonBody(req)
          const h = findHost(body.host)
          if (!h) return err(res, 404, `未找到主机 ${body.host}`)
          const r = await sshExec(h, body.command, { timeout: (body.timeout || 60) * 1000 })
          return ok(res, { ok: r.code === 0, code: r.code, stdout: trimOutput(r.stdout, 8000), stderr: trimOutput(r.stderr, 4000) })
        }

        if (method === 'POST' && path === '/ssh/batch') {
          const body = await jsonBody(req)
          const timeout = (body.timeout || 60) * 1000
          const stopOnFailure = body.stop_on_failure !== false
          const concurrency = Math.max(1, Math.min(body.concurrency || 1, 20))
          const results = []
          let stopped = false

          async function runOne(n) {
            const h = findHost(n)
            if (!h) return { host: n, code: -1, stdout: '', stderr: `未找到主机 ${n}` }
            const r = await sshExec(h, body.command, { timeout })
            return { host: n, code: r.code, stdout: r.stdout?.slice(0, 2000) || '', stderr: r.stderr?.slice(0, 1000) || '' }
          }

          if (concurrency <= 1) {
            for (let i = 0; i < body.hosts.length; i++) {
              const r = await runOne(body.hosts[i])
              results.push(r)
              if (r.code !== 0 && stopOnFailure) {
                if (i === 0) results.push({ host: '_canary', code: -1, stdout: '', stderr: `canary ${body.hosts[i]} 失败，后续 ${body.hosts.length - 1} 台已跳过` })
                break
              }
            }
          } else {
            const hosts = [...body.hosts]
            let idx = 0
            async function worker() {
              while (idx < hosts.length && !stopped) {
                const i = idx++
                const r = await runOne(hosts[i])
                results.push(r)
                if (r.code !== 0 && stopOnFailure) stopped = true
              }
            }
            await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, () => worker()))
          }
          return ok(res, { ok: results.every(r => r.code === 0), results })
        }

        // ───── SSH Files ─────
        if (method === 'POST' && path === '/ssh/file/list') {
          const body = await jsonBody(req)
          const h = findHost(body.host)
          if (!h) return err(res, 404, `未找到主机 ${body.host}`)
          const lsFlags = body.all ? '-la' : '-l'
          const r = await sshExec(h, `ls ${lsFlags} --time-style=long-iso ${JSON.stringify(body.path)}`, { timeout: 15000 })
          if (r.code !== 0) return ok(res, { ok: false, error: r.stderr || `exit ${r.code}`, raw: '' })
          const lines = r.stdout.split('\n').filter(l => l.trim() && !l.startsWith('total'))
          const files = lines.map(line => {
            const parts = line.split(/\s+/)
            if (parts.length < 8) return null
            const perm = parts[0], size = parts[4], date = parts[5], time = parts[6]
            const name = parts.slice(7).join(' ').replace(/ -> .*$/, '')
            const isDir = perm.startsWith('d')
            const isLink = perm.startsWith('l')
            return { name, perm, size: parseInt(size) || 0, modified: `${date} ${time}`, isDir, isLink }
          }).filter(Boolean)
          return ok(res, { ok: true, files, path: body.path })
        }

        if (method === 'POST' && path === '/ssh/file/read') {
          const body = await jsonBody(req)
          const h = findHost(body.host)
          if (!h) return err(res, 404, `未找到主机 ${body.host}`)
          const cmd = body.tail ? `tail -n ${body.tail} ${JSON.stringify(body.path)}` : `cat ${JSON.stringify(body.path)}`
          const r = await sshExec(h, cmd, { timeout: 30000 })
          if (r.code !== 0) return ok(res, { ok: false, error: r.stderr || `exit ${r.code}` })
          return ok(res, { ok: true, content: trimOutput(r.stdout, 50000) })
        }

        // ───── SSH Snippets ─────
        if (method === 'GET' && path === '/ssh/snippets') {
          return ok(res, loadSnippets())
        }

        if (method === 'POST' && path === '/ssh/snippets') {
          const body = await jsonBody(req)
          if (!body.name || !body.command) return err(res, 400, 'name 和 command 必填')
          const list = loadSnippets()
          if (list.find(s => s.name === body.name)) return err(res, 400, `片段 ${body.name} 已存在`)
          list.push({ name: body.name, command: body.command, description: body.description || '', tags: body.tags || [], addedAt: new Date().toISOString() })
          saveSnippets(list)
          return ok(res, { ok: true, snippets: list })
        }

        const snippetMatch = path.match(/^\/ssh\/snippets\/([^/]+)$/)
        if (snippetMatch) {
          const sName = decodeURIComponent(snippetMatch[1])
          if (method === 'DELETE') {
            const list = loadSnippets()
            const idx = list.findIndex(s => s.name === sName)
            if (idx === -1) return err(res, 404, `片段 ${sName} 不存在`)
            list.splice(idx, 1)
            saveSnippets(list)
            return ok(res, { ok: true, snippets: list })
          }
          if (method === 'PUT') {
            const body = await jsonBody(req)
            const list = loadSnippets()
            const s = list.find(s => s.name === sName)
            if (!s) return err(res, 404, `片段 ${sName} 不存在`)
            if (body.command !== undefined) s.command = body.command
            if (body.description !== undefined) s.description = body.description
            if (body.tags !== undefined) s.tags = body.tags
            saveSnippets(list)
            return ok(res, { ok: true, snippets: list })
          }
        }

        const snippetExecMatch = path.match(/^\/ssh\/snippets\/([^/]+)\/exec$/)
        if (method === 'POST' && snippetExecMatch) {
          const sName = decodeURIComponent(snippetExecMatch[1])
          const body = await jsonBody(req)
          const list = loadSnippets()
          const s = list.find(s => s.name === sName)
          if (!s) return err(res, 404, `片段 ${sName} 不存在`)
          const h = findHost(body.host)
          if (!h) return err(res, 404, `未找到主机 ${body.host}`)
          const command = substituteVars(s.command, {
            hostName: h.name, hostname: h.hostname,
            user: h.user, port: h.port,
            vars: body.vars || {},
          })
          const r = await sshExec(h, command, { timeout: (body.timeout || 60) * 1000 })
          return ok(res, { ok: r.code === 0, code: r.code, command, stdout: trimOutput(r.stdout, 8000), stderr: trimOutput(r.stderr, 4000) })
        }

        if (method === 'POST' && path === '/ssh/snippets/vars') {
          const body = await jsonBody(req)
          return ok(res, { vars: extractVars(body.template || '') })
        }

        // ───── SSH Keys ─────
        if (method === 'GET' && path === '/ssh/keys') {
          const keys = await listKeys()
          return ok(res, keys)
        }

        if (method === 'POST' && path === '/ssh/keys/generate') {
          const body = await jsonBody(req)
          const r = await generateKey({ type: body.type, bits: body.bits, comment: body.comment, path: body.path })
          if (!r.ok) return err(res, 400, r.error)
          return ok(res, r)
        }

        const keyMatch = path.match(/^\/ssh\/keys\/([^/]+)$/)
        if (method === 'DELETE' && keyMatch) {
          const r = deleteKey(decodeURIComponent(keyMatch[1]))
          if (!r.ok) return err(res, 400, r.error)
          return ok(res, { ok: true, deleted: r.deleted })
        }

        // ───── SSH Tunnels ─────
        if (method === 'GET' && path === '/ssh/tunnels') {
          return ok(res, listTunnels())
        }

        if (method === 'POST' && path === '/ssh/tunnels') {
          const body = await jsonBody(req)
          if (!body.host || !body.type || !body.localPort) return err(res, 400, 'host, type, localPort 必填')
          const r = createTunnel({ hostName: body.host, type: body.type, localPort: body.localPort, remoteHost: body.remoteHost, remotePort: body.remotePort })
          if (!r.ok) return err(res, 400, r.error)
          return ok(res, r)
        }

        const tunnelMatch = path.match(/^\/ssh\/tunnels\/([^/]+)$/)
        if (method === 'DELETE' && tunnelMatch) {
          const r = closeTunnel(decodeURIComponent(tunnelMatch[1]))
          if (!r.ok) return err(res, 400, r.error)
          return ok(res, { ok: true, tunnels: listTunnels() })
        }

        // ───── SSH File Operations ─────
        if (method === 'POST' && path === '/ssh/file/mkdir') {
          const body = await jsonBody(req)
          const h = findHost(body.host)
          if (!h) return err(res, 404, `未找到主机 ${body.host}`)
          const r = await sshExec(h, `mkdir -p ${JSON.stringify(body.path)}`, { timeout: 15000 })
          return ok(res, { ok: r.code === 0, stderr: r.stderr })
        }

        if (method === 'POST' && path === '/ssh/file/delete') {
          const body = await jsonBody(req)
          const h = findHost(body.host)
          if (!h) return err(res, 404, `未找到主机 ${body.host}`)
          const target_path = body.path
          if (!target_path || target_path === '/' || target_path === '~') return err(res, 400, '不允许删除根目录')
          const flag = body.recursive ? '-rf' : '-f'
          const r = await sshExec(h, `rm ${flag} ${JSON.stringify(target_path)}`, { timeout: 15000 })
          return ok(res, { ok: r.code === 0, stderr: r.stderr })
        }

        if (method === 'POST' && path === '/ssh/file/write') {
          const body = await jsonBody(req)
          const h = findHost(body.host)
          if (!h) return err(res, 404, `未找到主机 ${body.host}`)
          const r = await sshExec(h, `cat > ${JSON.stringify(body.path)} << 'DSHEOF'\n${body.content}\nDSHEOF`, { timeout: 30000 })
          return ok(res, { ok: r.code === 0, stderr: r.stderr })
        }

        // ───── K8s helper ─────
        function kArgs(ctxName, extra = []) {
          const c = findContext(ctxName)
          return c ? buildKubectlArgs(c, extra) : ['--context', ctxName, ...extra]
        }

        if (method === 'POST' && path === '/k8s/browse-local') {
          const body = await jsonBody(req)
          let dir = body.path || join(homedir(), '.kube')
          dir = dir.replace(/^~/, homedir())
          try {
            const st = statSync(dir)
            if (!st.isDirectory()) return ok(res, { ok: true, isFile: true, path: dir })
          } catch { return err(res, 400, '路径不存在: ' + dir) }
          try {
            const entries = readdirSync(dir, { withFileTypes: true }).map(e => ({
              name: e.name, isDir: e.isDirectory(),
              path: join(dir, e.name),
            })).filter(e => !e.name.startsWith('.') || body.showHidden).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name))
            return ok(res, { ok: true, dir, entries, parent: join(dir, '..') })
          } catch (e) { return err(res, 400, '无法读取目录: ' + e.message) }
        }

        // ───── K8s Contexts ─────
        if (method === 'GET' && path === '/k8s/contexts') {
          return ok(res, loadContexts())
        }

        if (method === 'POST' && path === '/k8s/contexts') {
          const body = await jsonBody(req)
          const r = addContext(body)
          if (!r.ok) return err(res, 400, r.why)
          return ok(res, { ok: true, contexts: loadContexts() })
        }

        const ctxMatch = path.match(/^\/k8s\/contexts\/([^/]+)$/)
        if (method === 'DELETE' && ctxMatch) {
          const r = removeContext(decodeURIComponent(ctxMatch[1]))
          if (!r.ok) return err(res, 400, r.why)
          return ok(res, { ok: true, contexts: loadContexts() })
        }

        if (method === 'POST' && path === '/k8s/parse-kubeconfig') {
          const body = await jsonBody(req)
          const input = body.content || body.path || ''
          if (!input) return err(res, 400, '请提供 kubeconfig 路径或内容')
          const r = await parseKubeconfig(input)
          if (!r.ok) return err(res, 400, r.error)
          return ok(res, r)
        }

        if (method === 'POST' && path === '/k8s/import-contexts') {
          const body = await jsonBody(req)
          if (!body.selected?.length) return err(res, 400, '请选择至少一个上下文')
          const input = body.content || body.path || ''
          const parsed = await parseKubeconfig(input)
          if (!parsed.ok) return err(res, 400, parsed.error)
          const results = importContexts(parsed, body.selected, body.path || undefined)
          return ok(res, { ok: true, results, contexts: loadContexts() })
        }

        const ctxTestMatch = path.match(/^\/k8s\/contexts\/([^/]+)\/test$/)
        if (method === 'POST' && ctxTestMatch) {
          const name = decodeURIComponent(ctxTestMatch[1])
          const args = kArgs(name, ['cluster-info'])
          const r = await exec('kubectl', args, { timeout: 10000 })
          return ok(res, { ok: r.code === 0, output: r.code === 0 ? r.stdout.split('\n').slice(0, 3).join('\n') : r.stderr })
        }

        // ───── K8s Overview ─────
        if (method === 'POST' && path === '/k8s/overview') {
          const body = await jsonBody(req)
          const base = kArgs(body.context)
          const [nodesR, podsR, deploysR, nsR, evtsR, verR] = await Promise.all([
            exec('kubectl', [...base, 'get', 'nodes', '-o', 'json'], { timeout: 15000 }),
            exec('kubectl', [...base, 'get', 'pods', '-A', '-o', 'json', '--field-selector=status.phase!=Succeeded'], { timeout: 15000 }),
            exec('kubectl', [...base, 'get', 'deployments', '-A', '-o', 'json'], { timeout: 15000 }),
            exec('kubectl', [...base, 'get', 'namespaces', '-o', 'json'], { timeout: 10000 }),
            exec('kubectl', [...base, 'get', 'events', '-A', '--field-selector=type=Warning', '--sort-by=.lastTimestamp', '-o', 'json'], { timeout: 10000 }),
            exec('kubectl', [...base, 'version', '-o', 'json'], { timeout: 10000 }),
          ])
          const parseItems = (r) => { try { return JSON.parse(r.stdout)?.items || [] } catch { return [] } }
          const nodes = parseItems(nodesR)
          const pods = parseItems(podsR)
          const deploys = parseItems(deploysR)
          const nsList = parseItems(nsR).map(n => n.metadata?.name).filter(Boolean)
          const events = parseItems(evtsR).slice(0, 20).map(e => ({
            type: e.type, reason: e.reason, message: e.message,
            object: `${e.involvedObject?.kind}/${e.involvedObject?.name}`,
            lastTimestamp: e.lastTimestamp || e.eventTime,
            count: e.count || 1,
          }))
          let version = {}
          try { version = JSON.parse(verR.stdout) } catch {}
          return ok(res, {
            ok: true,
            nodes: { total: nodes.length, ready: nodes.filter(n => n.status?.conditions?.find(c => c.type === 'Ready' && c.status === 'True')).length },
            pods: {
              total: pods.length,
              running: pods.filter(p => p.status?.phase === 'Running').length,
              pending: pods.filter(p => p.status?.phase === 'Pending').length,
              failed: pods.filter(p => p.status?.phase === 'Failed').length,
            },
            deployments: {
              total: deploys.length,
              available: deploys.filter(d => (d.status?.availableReplicas || 0) >= (d.spec?.replicas || 1)).length,
            },
            namespaces: nsList,
            events,
            version: { server: version.serverVersion?.gitVersion || '', platform: version.serverVersion?.platform || '' },
          })
        }

        // ───── K8s Resources ─────
        if (method === 'POST' && path === '/k8s/resources') {
          const body = await jsonBody(req)
          const args = kArgs(body.context, ['get', body.kind])
          if (body.name) args.push(body.name)
          if (body.namespace) args.push('-n', body.namespace)
          else if (body.all_namespaces) args.push('--all-namespaces')
          if (body.label_selector) args.push('-l', body.label_selector)
          args.push('-o', body.name ? 'yaml' : 'json')
          const r = await exec('kubectl', args, { timeout: 15000 })
          if (body.name) return ok(res, { ok: r.code === 0, output: trimOutput(r.stdout, 30000), stderr: r.stderr })
          let items = []
          try { items = JSON.parse(r.stdout)?.items || [] } catch {}
          return ok(res, { ok: r.code === 0, items, stderr: r.stderr })
        }

        if (method === 'POST' && path === '/k8s/describe') {
          const body = await jsonBody(req)
          const args = kArgs(body.context, ['describe', body.kind, body.name])
          if (body.namespace) args.push('-n', body.namespace)
          const r = await exec('kubectl', args, { timeout: 15000 })
          return ok(res, { ok: r.code === 0, output: trimOutput(r.stdout, 30000), stderr: r.stderr })
        }

        if (method === 'POST' && path === '/k8s/logs') {
          const body = await jsonBody(req)
          const args = kArgs(body.context, ['logs', body.pod])
          if (body.namespace) args.push('-n', body.namespace)
          if (body.container) args.push('-c', body.container)
          if (body.previous) args.push('--previous')
          args.push('--tail', String(body.tail || 200))
          if (body.since) args.push('--since', body.since)
          const r = await exec('kubectl', args, { timeout: 30000 })
          return ok(res, { ok: r.code === 0, output: trimOutput(r.stdout, 50000), stderr: r.stderr })
        }

        if (method === 'POST' && path === '/k8s/events') {
          const body = await jsonBody(req)
          const args = kArgs(body.context, ['get', 'events', '--sort-by=.lastTimestamp', '-o', 'json'])
          if (body.namespace) args.push('-n', body.namespace)
          else if (body.all_namespaces) args.push('--all-namespaces')
          if (body.type) args.push('--field-selector', `type=${body.type}`)
          const r = await exec('kubectl', args, { timeout: 15000 })
          let items = []
          try { items = JSON.parse(r.stdout)?.items || [] } catch {}
          return ok(res, { ok: r.code === 0, items: items.slice(0, 100).map(e => ({
            type: e.type, reason: e.reason, message: e.message,
            object: `${e.involvedObject?.kind}/${e.involvedObject?.name}`,
            namespace: e.involvedObject?.namespace || '',
            lastTimestamp: e.lastTimestamp || e.eventTime,
            count: e.count || 1,
          })), stderr: r.stderr })
        }

        if (method === 'POST' && path === '/k8s/exec') {
          const body = await jsonBody(req)
          const args = kArgs(body.context, ['exec', body.pod])
          if (body.namespace) args.push('-n', body.namespace)
          if (body.container) args.push('-c', body.container)
          const shell = body.shell || 'sh'
          args.push('--', shell, '-c', body.command)
          const r = await exec('kubectl', args, { timeout: (body.timeout || 60) * 1000 })
          return ok(res, { ok: r.code === 0, code: r.code, stdout: trimOutput(r.stdout, 8000), stderr: trimOutput(r.stderr, 4000) })
        }

        if (method === 'POST' && path === '/k8s/exec-terminal') {
          const body = await jsonBody(req)
          const ctx = findContext(body.context)
          if (!ctx) return err(res, 404, '集群不存在')
          const args = buildKubectlArgs(ctx, ['exec', '-it', body.pod])
          if (body.namespace) args.push('-n', body.namespace)
          if (body.container) args.push('-c', body.container)
          const shell = body.shell || 'sh'
          args.push('--', shell)
          const cmd = `kubectl ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`
          return ok(res, { ok: true, command: cmd })
        }

        if (method === 'POST' && path === '/k8s/top') {
          const body = await jsonBody(req)
          const args = kArgs(body.context, ['top', body.kind])
          if (body.namespace) args.push('-n', body.namespace)
          if (body.sort_by) args.push('--sort-by', body.sort_by)
          const r = await exec('kubectl', args, { timeout: 15000 })
          return ok(res, { ok: r.code === 0, output: trimOutput(r.stdout, 20000), stderr: r.stderr })
        }

        if (method === 'POST' && path === '/k8s/scale') {
          const body = await jsonBody(req)
          const args = kArgs(body.context, ['scale', `${body.kind}/${body.name}`, `--replicas=${body.replicas}`])
          if (body.namespace) args.push('-n', body.namespace)
          const r = await exec('kubectl', args, { timeout: 15000 })
          return ok(res, { ok: r.code === 0, output: r.stdout || r.stderr })
        }

        if (method === 'POST' && path === '/k8s/rollout') {
          const body = await jsonBody(req)
          const args = kArgs(body.context, ['rollout', body.action, `${body.kind}/${body.name}`])
          if (body.namespace) args.push('-n', body.namespace)
          if (body.action === 'undo' && body.to_revision) args.push(`--to-revision=${body.to_revision}`)
          const r = await exec('kubectl', args, { timeout: 30000 })
          return ok(res, { ok: r.code === 0, output: r.stdout || r.stderr })
        }

        if (method === 'POST' && path === '/k8s/delete-resource') {
          const body = await jsonBody(req)
          const args = kArgs(body.context, ['delete', body.kind, body.name])
          if (body.namespace) args.push('-n', body.namespace)
          const r = await exec('kubectl', args, { timeout: 30000 })
          return ok(res, { ok: r.code === 0, output: r.stdout || r.stderr })
        }

        if (method === 'POST' && path === '/k8s/apply') {
          const body = await jsonBody(req)
          const args = kArgs(body.context, ['apply', '-f', '-'])
          if (body.namespace) args.push('-n', body.namespace)
          if (body.dry_run) args.push('--dry-run=server')
          const r = await exec('kubectl', args, { timeout: 30000, stdin: body.manifest })
          return ok(res, { ok: r.code === 0, output: r.stdout || r.stderr })
        }

        // ───── Helm ─────
        function helmArgs(ctxName, extra = []) {
          const c = findContext(ctxName)
          if (!c) return ['--kube-context', ctxName, ...extra]
          const args = []
          const src = c.source || 'kubeconfig'
          if (src === 'kubeconfig') {
            if (c.kubeconfig) args.push('--kubeconfig', c.kubeconfig)
            if (c.context) args.push('--kube-context', c.context)
          } else {
            const cDir = join(dataDir(), 'k8s', 'creds', c.name)
            if (c.server) {
              args.push('--kube-apiserver', c.server)
              const caFile = join(cDir, 'ca.pem')
              if (existsSync(caFile)) args.push('--kube-ca-file', caFile)
              if (src === 'token') {
                const tokenFile = join(cDir, 'token')
                if (existsSync(tokenFile)) args.push('--kube-token', readFileSync(tokenFile, 'utf8').trim())
                else args.push('--kube-insecure-skip-tls-verify')
              } else if (src === 'cert') {
                const certFile = join(cDir, 'client.pem')
                const keyFile = join(cDir, 'client-key.pem')
                if (existsSync(certFile)) args.push('--kube-tls-serverName', c.server.replace(/^https?:\/\//, '').replace(/:\d+$/, ''))
              }
            }
          }
          args.push(...extra)
          return args
        }

        if (method === 'POST' && path === '/helm/list') {
          const body = await jsonBody(req)
          const args = helmArgs(body.context, ['list', '--output', 'json'])
          if (body.namespace) args.push('-n', body.namespace)
          else args.push('--all-namespaces')
          const r = await exec('helm', args, { timeout: 30000 })
          if (r.code !== 0) return ok(res, { ok: false, items: [], stderr: r.stderr })
          try { return ok(res, { ok: true, items: JSON.parse(r.stdout || '[]') }) }
          catch { return ok(res, { ok: true, items: [], output: r.stdout }) }
        }

        if (method === 'POST' && path === '/helm/status') {
          const body = await jsonBody(req)
          const args = helmArgs(body.context, ['status', body.release, '--output', 'json'])
          if (body.namespace) args.push('-n', body.namespace)
          const r = await exec('helm', args, { timeout: 15000 })
          if (r.code !== 0) return ok(res, { ok: false, output: r.stderr })
          try { return ok(res, { ok: true, data: JSON.parse(r.stdout) }) }
          catch { return ok(res, { ok: true, output: r.stdout }) }
        }

        if (method === 'POST' && path === '/helm/values') {
          const body = await jsonBody(req)
          const args = helmArgs(body.context, ['get', 'values', body.release, '--output', 'yaml'])
          if (body.namespace) args.push('-n', body.namespace)
          if (body.all) args.push('--all')
          const r = await exec('helm', args, { timeout: 15000 })
          return ok(res, { ok: r.code === 0, output: r.stdout || r.stderr })
        }

        if (method === 'POST' && path === '/helm/history') {
          const body = await jsonBody(req)
          const args = helmArgs(body.context, ['history', body.release, '--output', 'json'])
          if (body.namespace) args.push('-n', body.namespace)
          const r = await exec('helm', args, { timeout: 15000 })
          if (r.code !== 0) return ok(res, { ok: false, items: [], stderr: r.stderr })
          try { return ok(res, { ok: true, items: JSON.parse(r.stdout || '[]') }) }
          catch { return ok(res, { ok: true, items: [], output: r.stdout }) }
        }

        if (method === 'POST' && path === '/helm/install') {
          const body = await jsonBody(req)
          const args = helmArgs(body.context, ['install', body.release, body.chart])
          if (body.namespace) args.push('-n', body.namespace, '--create-namespace')
          if (body.version) args.push('--version', body.version)
          if (body.values) args.push('--values', '-')
          if (body.dry_run) args.push('--dry-run')
          const r = await exec('helm', args, { timeout: 120000, stdin: body.values || undefined })
          return ok(res, { ok: r.code === 0, output: r.stdout || r.stderr })
        }

        if (method === 'POST' && path === '/helm/upgrade') {
          const body = await jsonBody(req)
          const args = helmArgs(body.context, ['upgrade', body.release, body.chart])
          if (body.namespace) args.push('-n', body.namespace)
          if (body.version) args.push('--version', body.version)
          if (body.values) args.push('--values', '-')
          if (body.dry_run) args.push('--dry-run')
          if (body.reuse_values) args.push('--reuse-values')
          const r = await exec('helm', args, { timeout: 120000, stdin: body.values || undefined })
          return ok(res, { ok: r.code === 0, output: r.stdout || r.stderr })
        }

        if (method === 'POST' && path === '/helm/uninstall') {
          const body = await jsonBody(req)
          const args = helmArgs(body.context, ['uninstall', body.release])
          if (body.namespace) args.push('-n', body.namespace)
          if (body.dry_run) args.push('--dry-run')
          const r = await exec('helm', args, { timeout: 60000 })
          return ok(res, { ok: r.code === 0, output: r.stdout || r.stderr })
        }

        if (method === 'POST' && path === '/helm/search') {
          const body = await jsonBody(req)
          const args = ['search', body.source || 'repo', body.keyword || '', '--output', 'json']
          if (body.version) args.push('--version', body.version)
          if (body.versions) args.push('--versions')
          if (body.devel) args.push('--devel')
          const r = await exec('helm', args, { timeout: 30000 })
          if (r.code !== 0) return ok(res, { ok: false, items: [], stderr: r.stderr })
          try { return ok(res, { ok: true, items: JSON.parse(r.stdout || '[]') }) }
          catch { return ok(res, { ok: true, items: [], output: r.stdout }) }
        }

        if (method === 'POST' && path === '/helm/show') {
          const body = await jsonBody(req)
          const sub = body.sub || 'chart'
          const args = ['show', sub, body.chart]
          if (body.version) args.push('--version', body.version)
          const r = await exec('helm', args, { timeout: 30000 })
          return ok(res, { ok: r.code === 0, output: r.stdout || r.stderr })
        }

        if (method === 'POST' && path === '/helm/repo-list') {
          const r = await exec('helm', ['repo', 'list', '--output', 'json'], { timeout: 15000 })
          if (r.code !== 0) return ok(res, { ok: false, items: [], stderr: r.stderr })
          try { return ok(res, { ok: true, items: JSON.parse(r.stdout || '[]') }) }
          catch { return ok(res, { ok: true, items: [], output: r.stdout }) }
        }

        if (method === 'POST' && path === '/helm/repo-add') {
          const body = await jsonBody(req)
          const args = ['repo', 'add', body.name, body.url]
          if (body.force_update) args.push('--force-update')
          const r = await exec('helm', args, { timeout: 30000 })
          return ok(res, { ok: r.code === 0, output: r.stdout || r.stderr })
        }

        if (method === 'POST' && path === '/helm/repo-remove') {
          const body = await jsonBody(req)
          const r = await exec('helm', ['repo', 'remove', body.name], { timeout: 15000 })
          return ok(res, { ok: r.code === 0, output: r.stdout || r.stderr })
        }

        if (method === 'POST' && path === '/helm/repo-update') {
          const body = await jsonBody(req)
          const args = ['repo', 'update']
          if (body.name) args.push(body.name)
          const r = await exec('helm', args, { timeout: 60000 })
          return ok(res, { ok: r.code === 0, output: r.stdout || r.stderr })
        }

        // ───── 404 ─────
        err(res, 404, 'not found')

      } catch (e) {
        err(res, 500, String(e?.message || e))
      }
    },
  }), 'dsh-ops: API route')
}

export { apply, inject, name }
