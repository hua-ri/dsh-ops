import { exec, trimOutput } from '../cli.mjs'
import { loadInstances, findInstance, addInstance, removeInstance, buildArgocdArgs } from './instances.mjs'

export function registerArgocdTools(ctx, defineTool, toolsSvc, config) {
  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
  }
  const register = (tool) => toolsSvc.register(defineTool(tool))

  register({
    name: 'ops_argocd_apps',
    description: '列出 Argo CD 应用（名称、项目、同步状态、健康状态）。',
    parameters: {
      instance: { type: 'string', description: '实例名称（ops_argocd_instances 中注册的）', required: true },
      project: { type: 'string', description: '按项目过滤' },
      selector: { type: 'string', description: '标签选择器，如 team=payments' },
      output: { type: 'string', description: '输出格式：wide / json / yaml（默认表格）' },
    },
    output: textOutput,
    async execute(args) {
      const inst = findInstance(args.instance)
      if (!inst) return { ok: false, text: `未找到实例 ${args.instance}` }
      const a = buildArgocdArgs(inst, ['app', 'list'])
      if (args.project) a.push('-p', args.project)
      if (args.selector) a.push('-l', args.selector)
      if (args.output) a.push('-o', args.output)
      const r = await exec('argocd', a, { timeout: 30000 })
      if (r.code !== 0) return { ok: false, text: `argocd app list 失败：${r.stderr}` }
      return { ok: true, text: trimOutput(r.stdout) }
    },
  })

  register({
    name: 'ops_argocd_app',
    description: '查看一个 Argo CD 应用的详情（源、目标、同步策略、最近部署历史）。',
    parameters: {
      instance: { type: 'string', description: '实例名称', required: true },
      app: { type: 'string', description: '应用名称', required: true },
    },
    output: textOutput,
    async execute(args) {
      const inst = findInstance(args.instance)
      if (!inst) return { ok: false, text: `未找到实例 ${args.instance}` }
      const a = buildArgocdArgs(inst, ['app', 'get', args.app])
      const r = await exec('argocd', a, { timeout: 30000 })
      if (r.code !== 0) return { ok: false, text: `argocd app get 失败：${r.stderr}` }
      return { ok: true, text: trimOutput(r.stdout) }
    },
  })

  register({
    name: 'ops_argocd_diagnose',
    description: '诊断应用问题：查看 conditions、失败资源、out-of-sync 资源。',
    parameters: {
      instance: { type: 'string', description: '实例名称', required: true },
      app: { type: 'string', description: '应用名称', required: true },
    },
    output: textOutput,
    async execute(args) {
      const inst = findInstance(args.instance)
      if (!inst) return { ok: false, text: `未找到实例 ${args.instance}` }
      const sections = []

      const getR = await exec('argocd', buildArgocdArgs(inst, ['app', 'get', args.app]), { timeout: 30000 })
      if (getR.code === 0) sections.push('=== 应用状态 ===\n' + getR.stdout)

      const diffR = await exec('argocd', buildArgocdArgs(inst, ['app', 'diff', args.app]), { timeout: 30000 })
      if (diffR.stdout) sections.push('=== Diff（OutOfSync 资源）===\n' + diffR.stdout)

      const treeR = await exec('argocd', buildArgocdArgs(inst, ['app', 'resources', args.app]), { timeout: 30000 })
      if (treeR.code === 0) sections.push('=== 资源树 ===\n' + treeR.stdout)

      return { ok: true, text: trimOutput(sections.join('\n\n')) }
    },
  })

  register({
    name: 'ops_argocd_diff',
    description: '显示应用 OutOfSync 资源的 diff（live → desired）。',
    parameters: {
      instance: { type: 'string', description: '实例名称', required: true },
      app: { type: 'string', description: '应用名称', required: true },
    },
    output: textOutput,
    async execute(args) {
      const inst = findInstance(args.instance)
      if (!inst) return { ok: false, text: `未找到实例 ${args.instance}` }
      const r = await exec('argocd', buildArgocdArgs(inst, ['app', 'diff', args.app]), { timeout: 30000 })
      if (!r.stdout && r.code === 0) return { ok: true, text: '应用已同步，没有差异。' }
      return { ok: true, text: trimOutput(r.stdout || r.stderr) }
    },
  })

  register({
    name: 'ops_argocd_sync',
    description: '同步应用（默认 dry-run，需显式设 dry_run=false 才真正执行）。',
    parameters: {
      instance: { type: 'string', description: '实例名称', required: true },
      app: { type: 'string', description: '应用名称', required: true },
      dry_run: { type: 'boolean', description: '是否只做 dry-run（默认 true）' },
      prune: { type: 'boolean', description: '是否删除 Git 中已不存在的资源' },
      revision: { type: 'string', description: '同步到的 Git 版本' },
    },
    output: textOutput,
    async execute(args) {
      const inst = findInstance(args.instance)
      if (!inst) return { ok: false, text: `未找到实例 ${args.instance}` }
      const a = buildArgocdArgs(inst, ['app', 'sync', args.app])
      if (args.dry_run !== false) a.push('--dry-run')
      if (args.prune) a.push('--prune')
      if (args.revision) a.push('--revision', args.revision)
      const r = await exec('argocd', a, { timeout: 120000 })
      const prefix = args.dry_run !== false ? '[dry-run] ' : ''
      if (r.code !== 0) return { ok: false, text: `${prefix}argocd sync 失败：${r.stderr}` }
      return { ok: true, text: trimOutput(`${prefix}${r.stdout}`) }
    },
  })

  register({
    name: 'ops_argocd_rollback',
    description: '回滚应用到某个历史版本。需先关闭 auto-sync。',
    parameters: {
      instance: { type: 'string', description: '实例名称', required: true },
      app: { type: 'string', description: '应用名称', required: true },
      id: { type: 'number', description: '历史版本 ID（从 ops_argocd_app 的历史中获取）', required: true },
    },
    output: textOutput,
    async execute(args) {
      const inst = findInstance(args.instance)
      if (!inst) return { ok: false, text: `未找到实例 ${args.instance}` }
      const a = buildArgocdArgs(inst, ['app', 'rollback', args.app, String(args.id)])
      const r = await exec('argocd', a, { timeout: 60000 })
      if (r.code !== 0) return { ok: false, text: `argocd rollback 失败：${r.stderr}` }
      return { ok: true, text: trimOutput(r.stdout) }
    },
  })

  register({
    name: 'ops_argocd_refresh',
    description: '刷新应用：重新比较 Git 清单与集群状态（hard 时重新生成清单）。',
    parameters: {
      instance: { type: 'string', description: '实例名称', required: true },
      app: { type: 'string', description: '应用名称', required: true },
      hard: { type: 'boolean', description: '是否 hard refresh（重新渲染 Helm/Kustomize）' },
    },
    output: textOutput,
    async execute(args) {
      const inst = findInstance(args.instance)
      if (!inst) return { ok: false, text: `未找到实例 ${args.instance}` }
      const a = buildArgocdArgs(inst, ['app', 'get', args.app, '--refresh'])
      if (args.hard) a.push('--hard-refresh')
      const r = await exec('argocd', a, { timeout: 30000 })
      if (r.code !== 0) return { ok: false, text: `argocd refresh 失败：${r.stderr}` }
      return { ok: true, text: trimOutput(r.stdout) }
    },
  })

  register({
    name: 'ops_argocd_login',
    description: '登录 Argo CD 实例（使用 argocd login 命令）。',
    parameters: {
      instance: { type: 'string', description: '实例名称', required: true },
      username: { type: 'string', description: '用户名（如 admin）' },
      password: { type: 'string', description: '密码' },
      sso: { type: 'boolean', description: '是否使用 SSO（浏览器登录）' },
    },
    output: textOutput,
    async execute(args) {
      const inst = findInstance(args.instance)
      if (!inst) return { ok: false, text: `未找到实例 ${args.instance}` }
      const a = ['login', inst.server, '--grpc-web']
      if (args.sso) {
        a.push('--sso')
      } else if (args.username && args.password) {
        a.push('--username', args.username, '--password', args.password)
      } else {
        return { ok: false, text: '请提供 username+password 或设置 sso=true' }
      }
      a.push('--insecure')
      const r = await exec('argocd', a, { timeout: 60000 })
      if (r.code !== 0) return { ok: false, text: `argocd login 失败：${r.stderr}` }
      return { ok: true, text: '登录成功' }
    },
  })

  register({
    name: 'ops_argocd_instances',
    description: '管理 Argo CD 实例（列出/添加/删除）。',
    parameters: {
      action: { type: 'string', description: '操作（默认 list）：list / add / remove' },
      name: { type: 'string', description: 'add/remove 时的实例名称' },
      server: { type: 'string', description: 'add 时的服务器地址（如 argocd.example.com）' },
    },
    output: textOutput,
    async execute(args) {
      const action = args.action || 'list'
      if (action === 'list') {
        const instances = loadInstances()
        if (!instances.length) return { ok: true, text: '没有已保存的 ArgoCD 实例。用 ops_argocd_instances action=add 添加。' }
        const lines = instances.map((i) =>
          `${i.name}  server=${i.server}` +
          (i.tags?.length ? `  [${i.tags.join(', ')}]` : '') +
          (i.note ? `  — ${i.note}` : '')
        )
        return { ok: true, text: lines.join('\n') }
      }
      if (action === 'add') {
        if (!args.name || !args.server) return { ok: false, text: '需要 name 和 server 参数' }
        const r = addInstance({ name: args.name, server: args.server })
        return { ok: r.ok, text: r.ok ? `已添加实例 ${args.name}` : r.why }
      }
      if (action === 'remove') {
        if (!args.name) return { ok: false, text: '需要 name 参数' }
        const r = removeInstance(args.name)
        return { ok: r.ok, text: r.ok ? `已删除实例 ${args.name}` : r.why }
      }
      return { ok: false, text: `未知操作 ${action}` }
    },
  })
}
