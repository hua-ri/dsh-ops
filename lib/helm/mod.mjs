import { exec, trimOutput, dataDir } from '../cli.mjs'
import { findContext, buildKubectlArgs } from '../k8s/context.mjs'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

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
      }
    }
  }
  args.push(...extra)
  return args
}

export function registerHelmTools(ctx, defineTool, toolsSvc, config) {
  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
  }
  const register = (tool) => toolsSvc.register(defineTool(tool))

  register({
    name: 'ops_helm_list',
    description: '列出 Helm Releases。',
    parameters: {
      context: { type: 'string', description: 'kubectl context 名称', required: true },
      namespace: { type: 'string', description: '命名空间（不填则当前命名空间）' },
      all_namespaces: { type: 'boolean', description: '查看所有命名空间' },
    },
    output: textOutput,
    async execute(args) {
      const extra = ['list', '--output', 'json']
      if (args.namespace) extra.push('-n', args.namespace)
      if (args.all_namespaces) extra.push('-A')
      const r = await exec('helm', helmArgs(args.context, extra), { timeout: 30000 })
      if (r.code !== 0) return { ok: false, text: `helm list 失败：${r.stderr}` }
      try {
        const items = JSON.parse(r.stdout || '[]')
        if (!items.length) return { ok: true, text: '无 Helm Release' }
        const lines = items.map(i => `${i.name}  ns=${i.namespace}  chart=${i.chart}  status=${i.status}  v${i.revision || i.version || '-'}`)
        return { ok: true, text: lines.join('\n') }
      } catch { return { ok: true, text: r.stdout } }
    },
  })

  register({
    name: 'ops_helm_status',
    description: '查看 Helm Release 的状态详情。',
    parameters: {
      context: { type: 'string', description: 'kubectl context 名称', required: true },
      release: { type: 'string', description: 'Release 名称', required: true },
      namespace: { type: 'string', description: '命名空间' },
    },
    output: textOutput,
    async execute(args) {
      const extra = ['status', args.release, '--output', 'json']
      if (args.namespace) extra.push('-n', args.namespace)
      const r = await exec('helm', helmArgs(args.context, extra), { timeout: 15000 })
      if (r.code !== 0) return { ok: false, text: `helm status 失败：${r.stderr}` }
      try {
        const d = JSON.parse(r.stdout)
        const info = d.info || {}
        return { ok: true, text: `Release: ${d.name}\n状态: ${info.status}\n版本: ${d.version}\n命名空间: ${d.namespace}\n最后部署: ${info.last_deployed || '-'}\n描述: ${info.description || '-'}` }
      } catch { return { ok: true, text: r.stdout } }
    },
  })

  register({
    name: 'ops_helm_values',
    description: '获取 Helm Release 的 Values 配置。',
    parameters: {
      context: { type: 'string', description: 'kubectl context 名称', required: true },
      release: { type: 'string', description: 'Release 名称', required: true },
      namespace: { type: 'string', description: '命名空间' },
      all: { type: 'boolean', description: '显示所有 values（包含默认值）' },
    },
    output: textOutput,
    async execute(args) {
      const extra = ['get', 'values', args.release, '--output', 'yaml']
      if (args.namespace) extra.push('-n', args.namespace)
      if (args.all) extra.push('--all')
      const r = await exec('helm', helmArgs(args.context, extra), { timeout: 15000 })
      if (r.code !== 0) return { ok: false, text: `helm get values 失败：${r.stderr}` }
      return { ok: true, text: trimOutput(r.stdout || '无自定义 Values') }
    },
  })

  register({
    name: 'ops_helm_history',
    description: '查看 Helm Release 的部署历史。',
    parameters: {
      context: { type: 'string', description: 'kubectl context 名称', required: true },
      release: { type: 'string', description: 'Release 名称', required: true },
      namespace: { type: 'string', description: '命名空间' },
    },
    output: textOutput,
    async execute(args) {
      const extra = ['history', args.release, '--output', 'json']
      if (args.namespace) extra.push('-n', args.namespace)
      const r = await exec('helm', helmArgs(args.context, extra), { timeout: 15000 })
      if (r.code !== 0) return { ok: false, text: `helm history 失败：${r.stderr}` }
      try {
        const items = JSON.parse(r.stdout || '[]')
        if (!items.length) return { ok: true, text: '无历史记录' }
        const lines = items.map(h => `v${h.revision}  ${h.status}  chart=${h.chart}  app=${h.app_version || '-'}  ${h.description || ''}`)
        return { ok: true, text: lines.join('\n') }
      } catch { return { ok: true, text: r.stdout } }
    },
  })

  register({
    name: 'ops_helm_install',
    description: '安装 Helm Chart（默认 dry-run，需显式设 dry_run=false 才真正安装）。',
    parameters: {
      context: { type: 'string', description: 'kubectl context 名称', required: true },
      release: { type: 'string', description: 'Release 名称', required: true },
      chart: { type: 'string', description: 'Chart（repo/name 或 URL）', required: true },
      namespace: { type: 'string', description: '命名空间' },
      version: { type: 'string', description: 'Chart 版本' },
      values: { type: 'string', description: '自定义 Values（YAML 格式）' },
      dry_run: { type: 'boolean', description: '是否只做 dry-run（默认 true）' },
    },
    output: textOutput,
    async execute(args) {
      const extra = ['install', args.release, args.chart]
      if (args.namespace) extra.push('-n', args.namespace, '--create-namespace')
      if (args.version) extra.push('--version', args.version)
      if (args.values) extra.push('--values', '-')
      if (args.dry_run !== false) extra.push('--dry-run')
      const r = await exec('helm', helmArgs(args.context, extra), { timeout: 120000, stdin: args.values || undefined })
      const prefix = args.dry_run !== false ? '[dry-run] ' : ''
      if (r.code !== 0) return { ok: false, text: `${prefix}helm install 失败：${r.stderr || r.stdout}` }
      return { ok: true, text: trimOutput(`${prefix}${r.stdout}`) }
    },
  })

  register({
    name: 'ops_helm_upgrade',
    description: '升级 Helm Release（默认 dry-run）。',
    parameters: {
      context: { type: 'string', description: 'kubectl context 名称', required: true },
      release: { type: 'string', description: 'Release 名称', required: true },
      chart: { type: 'string', description: 'Chart（repo/name 或 URL）', required: true },
      namespace: { type: 'string', description: '命名空间' },
      version: { type: 'string', description: 'Chart 版本' },
      values: { type: 'string', description: '自定义 Values（YAML 格式）' },
      reuse_values: { type: 'boolean', description: '复用现有 Values' },
      dry_run: { type: 'boolean', description: '是否只做 dry-run（默认 true）' },
    },
    output: textOutput,
    async execute(args) {
      const extra = ['upgrade', args.release, args.chart]
      if (args.namespace) extra.push('-n', args.namespace)
      if (args.version) extra.push('--version', args.version)
      if (args.values) extra.push('--values', '-')
      if (args.reuse_values) extra.push('--reuse-values')
      if (args.dry_run !== false) extra.push('--dry-run')
      const r = await exec('helm', helmArgs(args.context, extra), { timeout: 120000, stdin: args.values || undefined })
      const prefix = args.dry_run !== false ? '[dry-run] ' : ''
      if (r.code !== 0) return { ok: false, text: `${prefix}helm upgrade 失败：${r.stderr || r.stdout}` }
      return { ok: true, text: trimOutput(`${prefix}${r.stdout}`) }
    },
  })

  register({
    name: 'ops_helm_uninstall',
    description: '卸载 Helm Release（会删除所有关联的 K8s 资源）。默认 dry-run。',
    parameters: {
      context: { type: 'string', description: 'kubectl context 名称', required: true },
      release: { type: 'string', description: 'Release 名称', required: true },
      namespace: { type: 'string', description: '命名空间' },
      dry_run: { type: 'boolean', description: '是否只做 dry-run（默认 true）' },
    },
    output: textOutput,
    async execute(args) {
      const extra = ['uninstall', args.release]
      if (args.namespace) extra.push('-n', args.namespace)
      if (args.dry_run !== false) extra.push('--dry-run')
      const r = await exec('helm', helmArgs(args.context, extra), { timeout: 60000 })
      const prefix = args.dry_run !== false ? '[dry-run] ' : ''
      if (r.code !== 0) return { ok: false, text: `${prefix}helm uninstall 失败：${r.stderr}` }
      return { ok: true, text: `${prefix}${r.stdout || `已卸载 ${args.release}`}` }
    },
  })

  register({
    name: 'ops_helm_repo',
    description: '管理 Helm 仓库：list 列出、add 添加、remove 删除、update 更新索引。',
    parameters: {
      action: { type: 'string', enum: ['list', 'add', 'remove', 'update'], description: '操作（默认 list）' },
      name: { type: 'string', description: 'add/remove 时仓库名称' },
      url: { type: 'string', description: 'add 时仓库 URL' },
    },
    output: textOutput,
    async execute(args) {
      const action = args.action || 'list'
      if (action === 'list') {
        const r = await exec('helm', ['repo', 'list', '--output', 'json'], { timeout: 15000 })
        if (r.code !== 0) return { ok: false, text: `helm repo list 失败：${r.stderr}` }
        try {
          const items = JSON.parse(r.stdout || '[]')
          if (!items.length) return { ok: true, text: '无 Helm 仓库' }
          return { ok: true, text: items.map(r => `${r.name}  ${r.url}`).join('\n') }
        } catch { return { ok: true, text: r.stdout } }
      }
      if (action === 'add') {
        if (!args.name || !args.url) return { ok: false, text: '需要 name 和 url 参数' }
        const r = await exec('helm', ['repo', 'add', args.name, args.url, '--force-update'], { timeout: 30000 })
        return { ok: r.code === 0, text: r.code === 0 ? `已添加仓库 ${args.name}` : `添加失败：${r.stderr || r.stdout}` }
      }
      if (action === 'remove') {
        if (!args.name) return { ok: false, text: '需要 name 参数' }
        const r = await exec('helm', ['repo', 'remove', args.name], { timeout: 15000 })
        return { ok: r.code === 0, text: r.code === 0 ? `已删除仓库 ${args.name}` : `删除失败：${r.stderr || r.stdout}` }
      }
      if (action === 'update') {
        const updateArgs = ['repo', 'update']
        if (args.name) updateArgs.push(args.name)
        const r = await exec('helm', updateArgs, { timeout: 60000 })
        return { ok: r.code === 0, text: r.code === 0 ? trimOutput(r.stdout) : `更新失败：${r.stderr || r.stdout}` }
      }
      return { ok: false, text: `未知操作 ${action}` }
    },
  })

  register({
    name: 'ops_helm_search',
    description: '搜索 Helm Chart（从已添加的仓库中搜索）。',
    parameters: {
      keyword: { type: 'string', description: '搜索关键词', required: true },
      versions: { type: 'boolean', description: '显示所有版本' },
    },
    output: textOutput,
    async execute(args) {
      const extra = ['search', 'repo', args.keyword, '--output', 'json']
      if (args.versions) extra.push('--versions')
      const r = await exec('helm', extra, { timeout: 30000 })
      if (r.code !== 0) return { ok: false, text: `helm search 失败：${r.stderr}` }
      try {
        const items = JSON.parse(r.stdout || '[]')
        if (!items.length) return { ok: true, text: '未找到匹配的 Chart' }
        const lines = items.map(c => `${c.name}  v${c.version}  app=${c.app_version || '-'}  ${(c.description || '').slice(0, 80)}`)
        return { ok: true, text: trimOutput(lines.join('\n')) }
      } catch { return { ok: true, text: r.stdout } }
    },
  })

  register({
    name: 'ops_helm_show',
    description: '查看 Chart 的详情（chart 元数据、values 默认值、readme）。',
    parameters: {
      chart: { type: 'string', description: 'Chart 名称（repo/name）', required: true },
      sub: { type: 'string', enum: ['chart', 'values', 'readme'], description: '查看内容（默认 chart）' },
      version: { type: 'string', description: 'Chart 版本' },
    },
    output: textOutput,
    async execute(args) {
      const sub = args.sub || 'chart'
      const extra = ['show', sub, args.chart]
      if (args.version) extra.push('--version', args.version)
      const r = await exec('helm', extra, { timeout: 30000 })
      if (r.code !== 0) return { ok: false, text: `helm show ${sub} 失败：${r.stderr}` }
      return { ok: true, text: trimOutput(r.stdout) }
    },
  })
}
