import { exec, trimOutput } from '../cli.mjs'
import { loadHosts, findHost, addHost, removeHost, updateHost, buildSshArgs } from './hosts.mjs'
import { readSshConfig } from './config.mjs'
import { createTunnel, listTunnels, closeTunnel } from './tunnels.mjs'
import { listKeys, generateKey } from './keys.mjs'
import { substituteVars, extractVars } from './snippet-vars.mjs'

export function registerSSHTools(ctx, defineTool, toolsSvc, config) {
  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
  }
  const register = (tool) => toolsSvc.register(defineTool(tool))

  register({
    name: 'ops_ssh_exec',
    description: '在远程主机上执行一条 shell 命令。需要先用 ops_ssh_hosts_add 添加主机。',
    parameters: {
      host: { type: 'string', description: '主机名（在 ops_ssh_hosts_list 中注册的名称）', required: true },
      command: { type: 'string', description: '要执行的 shell 命令', required: true },
      timeout: { type: 'number', description: '超时秒数，默认 60' },
    },
    output: textOutput,
    async execute(args) {
      const h = findHost(args.host)
      if (!h) return { ok: false, text: `未找到主机 ${args.host}，请先用 ops_ssh_hosts_add 添加` }
      const { args: sshArgs, target } = buildSshArgs(h)
      sshArgs.push(target, args.command)
      const timeout = (args.timeout || 60) * 1000
      const r = await exec('ssh', sshArgs, { timeout })
      return {
        ok: r.code === 0,
        text: trimOutput(
          `[exit ${r.code}] ${h.name} (${h.hostname})\n` +
          (r.stdout ? `stdout:\n${r.stdout}\n` : '') +
          (r.stderr ? `stderr:\n${r.stderr}` : '')
        ),
      }
    },
  })

  register({
    name: 'ops_ssh_batch',
    description: '在多台主机上批量执行同一条命令。第一台作为 canary 先执行，失败则不继续。',
    parameters: {
      hosts: { type: 'array', items: { type: 'string' }, description: '主机名列表', required: true },
      command: { type: 'string', description: '要执行的 shell 命令', required: true },
      timeout: { type: 'number', description: '每台超时秒数，默认 60' },
      stop_on_failure: { type: 'boolean', description: '某台失败后是否停止，默认 true' },
    },
    output: textOutput,
    async execute(args) {
      const timeout = (args.timeout || 60) * 1000
      const stopOnFailure = args.stop_on_failure !== false
      const results = []

      for (let i = 0; i < args.hosts.length; i++) {
        const name = args.hosts[i]
        const h = findHost(name)
        if (!h) {
          results.push({ host: name, code: -1, error: `未找到主机 ${name}` })
          if (stopOnFailure) break
          continue
        }
        const { args: sshArgs, target } = buildSshArgs(h)
        sshArgs.push(target, args.command)
        const r = await exec('ssh', sshArgs, { timeout })
        results.push({
          host: name,
          code: r.code,
          stdout: r.stdout?.slice(0, 500) || '',
          stderr: r.stderr?.slice(0, 300) || '',
        })
        if (r.code !== 0 && stopOnFailure) {
          if (i === 0) {
            results.push({ note: `canary ${name} 失败，后续 ${args.hosts.length - 1} 台已跳过` })
          }
          break
        }
      }

      const ok = results.every((r) => r.code === 0 || r.note)
      const lines = results.map((r) =>
        r.note || `[${r.host}] exit ${r.code}${r.stdout ? ': ' + r.stdout.split('\n')[0] : ''}`
      )
      return { ok, text: trimOutput(lines.join('\n')) }
    },
  })

  register({
    name: 'ops_ssh_hosts_list',
    description: '列出已保存的 SSH 主机。',
    parameters: {},
    output: textOutput,
    async execute() {
      const hosts = loadHosts()
      if (!hosts.length) return { ok: true, text: '没有已保存的主机。用 ops_ssh_hosts_add 添加。' }
      const lines = hosts.map((h) =>
        `${h.name}  ${h.user || ''}@${h.hostname}:${h.port || 22}` +
        (h.tags?.length ? `  [${h.tags.join(', ')}]` : '') +
        (h.note ? `  — ${h.note}` : '')
      )
      return { ok: true, text: lines.join('\n') }
    },
  })

  register({
    name: 'ops_ssh_hosts_add',
    description: '保存一台 SSH 主机，之后可以用名称引用它。',
    parameters: {
      name: { type: 'string', description: '主机的短名称（字母数字和 - _ .）', required: true },
      hostname: { type: 'string', description: 'IP 地址或域名', required: true },
      port: { type: 'number', description: 'SSH 端口，默认 22' },
      user: { type: 'string', description: '登录用户名' },
      identity_file: { type: 'string', description: '私钥文件路径（可选）' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签，如 env=prod' },
      note: { type: 'string', description: '备注' },
    },
    output: textOutput,
    async execute(args) {
      const r = addHost({
        name: args.name,
        hostname: args.hostname,
        port: args.port,
        user: args.user,
        identityFile: args.identity_file,
        tags: args.tags,
        note: args.note,
      })
      return { ok: r.ok, text: r.ok ? `已添加主机 ${args.name}` : r.why }
    },
  })

  register({
    name: 'ops_ssh_hosts_remove',
    description: '删除一台已保存的 SSH 主机。',
    parameters: {
      name: { type: 'string', description: '要删除的主机名', required: true },
    },
    output: textOutput,
    async execute(args) {
      const r = removeHost(args.name)
      return { ok: r.ok, text: r.ok ? `已删除主机 ${args.name}` : r.why }
    },
  })

  register({
    name: 'ops_ssh_file_read',
    description: '读取远程主机上的文本文件内容。',
    parameters: {
      host: { type: 'string', description: '主机名', required: true },
      path: { type: 'string', description: '远程文件路径', required: true },
      tail: { type: 'number', description: '只读取最后 N 行（可选）' },
    },
    output: textOutput,
    async execute(args) {
      const h = findHost(args.host)
      if (!h) return { ok: false, text: `未找到主机 ${args.host}` }
      const cmd = args.tail ? `tail -n ${args.tail} ${args.path}` : `cat ${args.path}`
      const { args: sshArgs, target } = buildSshArgs(h)
      sshArgs.push(target, cmd)
      const r = await exec('ssh', sshArgs, { timeout: 30000 })
      if (r.code !== 0) return { ok: false, text: `读取失败：${r.stderr || `exit ${r.code}`}` }
      return { ok: true, text: trimOutput(r.stdout) }
    },
  })

  register({
    name: 'ops_ssh_file_write',
    description: '将内容写入远程主机上的文件（覆盖）。',
    parameters: {
      host: { type: 'string', description: '主机名', required: true },
      path: { type: 'string', description: '远程文件路径', required: true },
      content: { type: 'string', description: '文件内容', required: true },
    },
    output: textOutput,
    async execute(args) {
      const h = findHost(args.host)
      if (!h) return { ok: false, text: `未找到主机 ${args.host}` }
      const { args: sshArgs, target } = buildSshArgs(h)
      sshArgs.push(target, `cat > ${args.path}`)
      const r = await exec('ssh', sshArgs, { timeout: 30000, stdin: args.content })
      if (r.code !== 0) return { ok: false, text: `写入失败：${r.stderr || `exit ${r.code}`}` }
      return { ok: true, text: `已写入 ${args.path}（${args.content.length} 字节）` }
    },
  })

  register({
    name: 'ops_ssh_file_list',
    description: '列出远程主机上某个目录的内容。',
    parameters: {
      host: { type: 'string', description: '主机名', required: true },
      path: { type: 'string', description: '远程目录路径', required: true },
      all: { type: 'boolean', description: '是否显示隐藏文件' },
    },
    output: textOutput,
    async execute(args) {
      const h = findHost(args.host)
      if (!h) return { ok: false, text: `未找到主机 ${args.host}` }
      const lsFlags = args.all ? '-la' : '-l'
      const { args: sshArgs, target } = buildSshArgs(h)
      sshArgs.push(target, `ls ${lsFlags} ${args.path}`)
      const r = await exec('ssh', sshArgs, { timeout: 15000 })
      if (r.code !== 0) return { ok: false, text: `列目录失败：${r.stderr || `exit ${r.code}`}` }
      return { ok: true, text: trimOutput(r.stdout) }
    },
  })

  register({
    name: 'ops_ssh_hosts_update',
    description: '修改已保存的 SSH 主机的配置（主机名、端口、用户、密钥、标签、备注等）。',
    parameters: {
      name: { type: 'string', description: '要修改的主机名', required: true },
      hostname: { type: 'string', description: '新的 IP 地址或域名' },
      port: { type: 'number', description: '新的 SSH 端口' },
      user: { type: 'string', description: '新的登录用户名' },
      identity_file: { type: 'string', description: '新的私钥文件路径' },
      proxy_jump: { type: 'string', description: '跳板机名称' },
      tags: { type: 'array', items: { type: 'string' }, description: '新的标签列表（替换全部）' },
      note: { type: 'string', description: '新的备注' },
    },
    output: textOutput,
    async execute(args) {
      const patch = {}
      if (args.hostname !== undefined) patch.hostname = args.hostname
      if (args.port !== undefined) patch.port = args.port
      if (args.user !== undefined) patch.user = args.user
      if (args.identity_file !== undefined) patch.identityFile = args.identity_file
      if (args.proxy_jump !== undefined) patch.proxyJump = args.proxy_jump
      if (args.tags !== undefined) patch.tags = args.tags
      if (args.note !== undefined) patch.note = args.note
      const r = updateHost(args.name, patch)
      return { ok: r.ok, text: r.ok ? `已更新主机 ${args.name}` : r.why }
    },
  })

  register({
    name: 'ops_ssh_config_import',
    description: '从本机 ~/.ssh/config 解析主机列表并导入（已存在的会跳过）。',
    parameters: {},
    output: textOutput,
    async execute() {
      const entries = readSshConfig()
      if (!entries.length) return { ok: true, text: '未在 ~/.ssh/config 中找到 Host 条目' }
      const existing = loadHosts()
      let added = 0, skipped = 0
      for (const e of entries) {
        if (!e.host || e.host.includes('*')) { skipped++; continue }
        if (existing.find(h => h.name === e.host)) { skipped++; continue }
        const r = addHost({
          name: e.host,
          hostname: e.hostname || e.host,
          port: e.port ? Number(e.port) : undefined,
          user: e.user,
          identityFile: e.identityFile,
          proxyJump: e.proxyJump,
        })
        if (r.ok) added++
        else skipped++
      }
      return { ok: true, text: `导入完成：新增 ${added} 台，跳过 ${skipped} 条` }
    },
  })

  register({
    name: 'ops_ssh_snippets',
    description: '管理命令片段：list 列出所有、get 获取单个、add 添加、remove 删除。',
    parameters: {
      action: { type: 'string', enum: ['list', 'get', 'add', 'remove'], description: '操作（默认 list）' },
      name: { type: 'string', description: '片段名称（add/get/remove 必填）' },
      command: { type: 'string', description: '命令模板（add 时必填，支持 ${var} 变量）' },
      description: { type: 'string', description: '描述（add 时可选）' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签（add 时可选）' },
    },
    output: textOutput,
    async execute(args) {
      const { readJson, writeJson, dataDir } = await import('../cli.mjs')
      const { join } = await import('node:path')
      const { mkdirSync } = await import('node:fs')
      const snippetsPath = join(dataDir(), 'ssh', 'snippets.json')
      const load = () => readJson(snippetsPath, [])
      const save = (list) => { mkdirSync(join(dataDir(), 'ssh'), { recursive: true }); writeJson(snippetsPath, list) }

      const action = args.action || 'list'
      if (action === 'list') {
        const list = load()
        if (!list.length) return { ok: true, text: '没有已保存的命令片段' }
        return { ok: true, text: list.map(s => `${s.name}  ${s.description || ''}\n  $ ${s.command}`).join('\n\n') }
      }
      if (action === 'get') {
        if (!args.name) return { ok: false, text: '需要 name 参数' }
        const list = load()
        const s = list.find(s => s.name === args.name)
        if (!s) return { ok: false, text: `片段 ${args.name} 不存在` }
        const vars = extractVars(s.command)
        return { ok: true, text: `名称: ${s.name}\n描述: ${s.description || '-'}\n命令: ${s.command}\n变量: ${vars.length ? vars.join(', ') : '无'}` }
      }
      if (action === 'add') {
        if (!args.name || !args.command) return { ok: false, text: '需要 name 和 command 参数' }
        const list = load()
        if (list.find(s => s.name === args.name)) return { ok: false, text: `片段 ${args.name} 已存在` }
        list.push({ name: args.name, command: args.command, description: args.description || '', tags: args.tags || [], addedAt: new Date().toISOString() })
        save(list)
        return { ok: true, text: `已添加片段 ${args.name}` }
      }
      if (action === 'remove') {
        if (!args.name) return { ok: false, text: '需要 name 参数' }
        const list = load()
        const idx = list.findIndex(s => s.name === args.name)
        if (idx === -1) return { ok: false, text: `片段 ${args.name} 不存在` }
        list.splice(idx, 1)
        save(list)
        return { ok: true, text: `已删除片段 ${args.name}` }
      }
      return { ok: false, text: `未知操作 ${action}` }
    },
  })

  register({
    name: 'ops_ssh_snippet_exec',
    description: '在主机上执行命令片段，可传入变量替换模板中的 ${var}。',
    parameters: {
      snippet: { type: 'string', description: '片段名称', required: true },
      host: { type: 'string', description: '目标主机名', required: true },
      vars: { type: 'object', properties: {}, additionalProperties: true, description: '变量键值对，如 { "port": "8080" }' },
      timeout: { type: 'number', description: '超时秒数，默认 60' },
    },
    output: textOutput,
    async execute(args) {
      const { readJson, dataDir } = await import('../cli.mjs')
      const { join } = await import('node:path')
      const list = readJson(join(dataDir(), 'ssh', 'snippets.json'), [])
      const s = list.find(s => s.name === args.snippet)
      if (!s) return { ok: false, text: `片段 ${args.snippet} 不存在` }
      const h = findHost(args.host)
      if (!h) return { ok: false, text: `未找到主机 ${args.host}` }
      const command = substituteVars(s.command, {
        hostName: h.name, hostname: h.hostname,
        user: h.user, port: h.port,
        vars: args.vars || {},
      })
      const { args: sshArgs, target } = buildSshArgs(h)
      sshArgs.push(target, command)
      const r = await exec('ssh', sshArgs, { timeout: (args.timeout || 60) * 1000 })
      return {
        ok: r.code === 0,
        text: trimOutput(`[exit ${r.code}] $ ${command}\n${r.stdout}${r.stderr ? '\nstderr: ' + r.stderr : ''}`),
      }
    },
  })

  register({
    name: 'ops_ssh_keys',
    description: '管理本机 SSH 密钥：list 列出、generate 生成新密钥。',
    parameters: {
      action: { type: 'string', enum: ['list', 'generate'], description: '操作（默认 list）' },
      type: { type: 'string', description: 'generate 时密钥类型：ed25519（推荐）、rsa' },
      comment: { type: 'string', description: 'generate 时的注释' },
      path: { type: 'string', description: 'generate 时密钥保存路径（可选）' },
    },
    output: textOutput,
    async execute(args) {
      const action = args.action || 'list'
      if (action === 'list') {
        const keys = await listKeys()
        if (!keys.length) return { ok: true, text: '未找到 SSH 密钥' }
        return { ok: true, text: keys.map(k => `${k.name}  ${k.type}  ${k.fingerprint || ''}`).join('\n') }
      }
      if (action === 'generate') {
        const r = await generateKey({ type: args.type, comment: args.comment, path: args.path })
        return { ok: r.ok, text: r.ok ? `已生成密钥：${r.path}\n公钥：${r.pubKey}` : (r.error || '生成失败') }
      }
      return { ok: false, text: `未知操作 ${action}` }
    },
  })

  register({
    name: 'ops_ssh_tunnels',
    description: '管理 SSH 隧道：list 列出、open 打开新隧道、close 关闭。',
    parameters: {
      action: { type: 'string', enum: ['list', 'open', 'close'], description: '操作（默认 list）' },
      host: { type: 'string', description: 'open 时目标主机名' },
      type: { type: 'string', enum: ['local', 'remote', 'dynamic'], description: 'open 时隧道类型（默认 local）' },
      local_port: { type: 'number', description: 'open 时本地端口' },
      remote_host: { type: 'string', description: 'open 时远程主机（默认 127.0.0.1）' },
      remote_port: { type: 'number', description: 'open 时远程端口' },
      id: { type: 'string', description: 'close 时隧道 ID' },
    },
    output: textOutput,
    async execute(args) {
      const action = args.action || 'list'
      if (action === 'list') {
        const tunnels = listTunnels()
        if (!tunnels.length) return { ok: true, text: '没有活跃的隧道' }
        return { ok: true, text: tunnels.map(t => `[${t.id}] ${t.hostName} ${t.type} ${t.localPort} → ${t.remoteHost || ''}:${t.remotePort || '*'} ${t.alive ? '✓' : '✗'}`).join('\n') }
      }
      if (action === 'open') {
        if (!args.host) return { ok: false, text: '需要 host 参数' }
        if (!args.local_port) return { ok: false, text: '需要 local_port 参数' }
        const r = createTunnel({
          hostName: args.host,
          type: args.type || 'local',
          localPort: args.local_port,
          remoteHost: args.remote_host || '127.0.0.1',
          remotePort: args.remote_port || args.local_port,
        })
        return { ok: r.ok, text: r.ok ? `隧道已打开 [${r.id}] localhost:${args.local_port} → ${args.remote_host || '127.0.0.1'}:${args.remote_port || args.local_port}` : (r.error || '打开失败') }
      }
      if (action === 'close') {
        if (!args.id) return { ok: false, text: '需要 id 参数' }
        const r = closeTunnel(args.id)
        return { ok: r.ok, text: r.ok ? `隧道 ${args.id} 已关闭` : (r.error || '关闭失败') }
      }
      return { ok: false, text: `未知操作 ${action}` }
    },
  })

  register({
    name: 'ops_ssh_file_mkdir',
    description: '在远程主机上创建目录（支持递归创建）。',
    parameters: {
      host: { type: 'string', description: '主机名', required: true },
      path: { type: 'string', description: '目录路径', required: true },
    },
    output: textOutput,
    async execute(args) {
      const h = findHost(args.host)
      if (!h) return { ok: false, text: `未找到主机 ${args.host}` }
      const { args: sshArgs, target } = buildSshArgs(h)
      sshArgs.push(target, `mkdir -p ${args.path}`)
      const r = await exec('ssh', sshArgs, { timeout: 15000 })
      if (r.code !== 0) return { ok: false, text: `创建目录失败：${r.stderr || `exit ${r.code}`}` }
      return { ok: true, text: `已创建目录 ${args.path}` }
    },
  })

  register({
    name: 'ops_ssh_file_delete',
    description: '删除远程主机上的文件或空目录。',
    parameters: {
      host: { type: 'string', description: '主机名', required: true },
      path: { type: 'string', description: '文件或目录路径', required: true },
      recursive: { type: 'boolean', description: '是否递归删除目录（危险）' },
    },
    output: textOutput,
    async execute(args) {
      const h = findHost(args.host)
      if (!h) return { ok: false, text: `未找到主机 ${args.host}` }
      const cmd = args.recursive ? `rm -rf ${args.path}` : `rm -f ${args.path}`
      const { args: sshArgs, target } = buildSshArgs(h)
      sshArgs.push(target, cmd)
      const r = await exec('ssh', sshArgs, { timeout: 15000 })
      if (r.code !== 0) return { ok: false, text: `删除失败：${r.stderr || `exit ${r.code}`}` }
      return { ok: true, text: `已删除 ${args.path}` }
    },
  })

  register({
    name: 'ops_ssh_perf',
    description: '获取远程主机的性能概况（CPU、内存、磁盘、负载）。',
    parameters: {
      host: { type: 'string', description: '主机名', required: true },
    },
    output: textOutput,
    async execute(args) {
      const h = findHost(args.host)
      if (!h) return { ok: false, text: `未找到主机 ${args.host}` }
      const cmd = `echo "=== LOAD ===" && uptime && echo "=== MEMORY ===" && free -h 2>/dev/null || vm_stat 2>/dev/null && echo "=== DISK ===" && df -h / && echo "=== CPU ===" && (nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null) && echo "cores"`
      const { args: sshArgs, target } = buildSshArgs(h)
      sshArgs.push(target, cmd)
      const r = await exec('ssh', sshArgs, { timeout: 15000 })
      if (r.code !== 0) return { ok: false, text: `获取性能信息失败：${r.stderr || `exit ${r.code}`}` }
      return { ok: true, text: trimOutput(`[${h.name}] 性能概况\n${r.stdout}`) }
    },
  })
}
