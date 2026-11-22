import { exec, trimOutput } from '../cli.mjs'
import { loadInstances, findInstance, addInstance, removeInstance, buildArgoArgs } from './instances.mjs'

export function registerArgowfTools(ctx, defineTool, toolsSvc, config) {
  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
  }
  const register = (tool) => toolsSvc.register(defineTool(tool))

  register({
    name: 'ops_argowf_list',
    description: '列出 Argo Workflows 工作流（最新在前）。',
    parameters: {
      instance: { type: 'string', description: '实例名称', required: true },
      namespace: { type: 'string', description: '命名空间（覆盖实例默认值）' },
      status: { type: 'string', enum: ['Running', 'Succeeded', 'Failed', 'Error', 'Pending'], description: '按状态过滤' },
      label_selector: { type: 'string', description: '标签选择器' },
      limit: { type: 'number', description: '返回数量限制，默认 50' },
    },
    output: textOutput,
    async execute(args) {
      const inst = findInstance(args.instance)
      if (!inst) return { ok: false, text: `未找到实例 ${args.instance}` }
      const a = buildArgoArgs(inst, ['list'])
      if (args.namespace) { a.splice(a.indexOf('-n'), 2); a.push('-n', args.namespace) }
      if (args.status) a.push('--status', args.status)
      if (args.label_selector) a.push('-l', args.label_selector)
      a.push('--chunk-size', String(args.limit || 50))
      const r = await exec('argo', a, { timeout: 30000 })
      if (r.code !== 0) return { ok: false, text: `argo list 失败：${r.stderr}` }
      return { ok: true, text: trimOutput(r.stdout) }
    },
  })

  register({
    name: 'ops_argowf_get',
    description: '查看工作流的详情（阶段、参数、节点树）。',
    parameters: {
      instance: { type: 'string', description: '实例名称', required: true },
      name: { type: 'string', description: '工作流名称', required: true },
      namespace: { type: 'string', description: '命名空间' },
    },
    output: textOutput,
    async execute(args) {
      const inst = findInstance(args.instance)
      if (!inst) return { ok: false, text: `未找到实例 ${args.instance}` }
      const a = buildArgoArgs(inst, ['get', args.name])
      if (args.namespace) { a.splice(a.indexOf('-n'), 2); a.push('-n', args.namespace) }
      const r = await exec('argo', a, { timeout: 30000 })
      if (r.code !== 0) return { ok: false, text: `argo get 失败：${r.stderr}` }
      return { ok: true, text: trimOutput(r.stdout) }
    },
  })

  register({
    name: 'ops_argowf_diagnose',
    description: '诊断失败的工作流：找出失败步骤、分类原因、获取日志。',
    parameters: {
      instance: { type: 'string', description: '实例名称', required: true },
      name: { type: 'string', description: '工作流名称', required: true },
      namespace: { type: 'string', description: '命名空间' },
    },
    output: textOutput,
    async execute(args) {
      const inst = findInstance(args.instance)
      if (!inst) return { ok: false, text: `未找到实例 ${args.instance}` }
      const sections = []
      const nsArgs = args.namespace ? ['-n', args.namespace] : (inst.namespace ? ['-n', inst.namespace] : [])

      const getR = await exec('argo', ['get', args.name, '--server', inst.server, ...nsArgs], { timeout: 30000 })
      if (getR.code === 0) sections.push('=== 工作流状态 ===\n' + getR.stdout)

      const logsR = await exec('argo', ['logs', args.name, '--server', inst.server, ...nsArgs, '--no-color'], { timeout: 30000 })
      if (logsR.code === 0 && logsR.stdout) {
        const lines = logsR.stdout.split('\n')
        const tail = lines.slice(-100).join('\n')
        sections.push('=== 最近日志（尾部100行）===\n' + tail)
      }

      return { ok: true, text: trimOutput(sections.join('\n\n')) }
    },
  })

  register({
    name: 'ops_argowf_logs',
    description: '查看工作流某个步骤的日志。',
    parameters: {
      instance: { type: 'string', description: '实例名称', required: true },
      name: { type: 'string', description: '工作流名称', required: true },
      node: { type: 'string', description: '步骤名称或 Pod 名称' },
      namespace: { type: 'string', description: '命名空间' },
      container: { type: 'string', description: '容器名，默认 main' },
      grep: { type: 'string', description: '过滤日志中包含此文本的行' },
    },
    output: textOutput,
    async execute(args) {
      const inst = findInstance(args.instance)
      if (!inst) return { ok: false, text: `未找到实例 ${args.instance}` }
      const a = buildArgoArgs(inst, ['logs', args.name, '--no-color'])
      if (args.namespace) { a.splice(a.indexOf('-n'), 2); a.push('-n', args.namespace) }
      if (args.node) a.push('--node-id', args.node)
      if (args.container) a.push('-c', args.container)
      if (args.grep) a.push('--grep', args.grep)
      const r = await exec('argo', a, { timeout: 30000 })
      if (r.code !== 0) return { ok: false, text: `argo logs 失败：${r.stderr}` }
      return { ok: true, text: trimOutput(r.stdout) }
    },
  })

  register({
    name: 'ops_argowf_submit',
    description: '提交 WorkflowTemplate 运行。parameters 传 JSON 字符串，如 \'{"key":"value"}\'。',
    parameters: {
      instance: { type: 'string', description: '实例名称', required: true },
      template: { type: 'string', description: 'WorkflowTemplate 名称', required: true },
      namespace: { type: 'string', description: '命名空间' },
      parameters: { type: 'string', description: '参数 JSON 对象字符串，如 {"key":"value"}' },
      dry_run: { type: 'boolean', description: '仅验证，不创建' },
    },
    output: textOutput,
    async execute(args) {
      const inst = findInstance(args.instance)
      if (!inst) return { ok: false, text: `未找到实例 ${args.instance}` }
      const a = buildArgoArgs(inst, ['submit', '--from', `wftmpl/${args.template}`])
      if (args.namespace) { a.splice(a.indexOf('-n'), 2); a.push('-n', args.namespace) }
      if (args.parameters) {
        try {
          const params = typeof args.parameters === 'string' ? JSON.parse(args.parameters) : args.parameters
          for (const [k, v] of Object.entries(params)) {
            a.push('-p', `${k}=${v}`)
          }
        } catch (e) {
          return { ok: false, text: `参数 JSON 解析失败：${e.message}` }
        }
      }
      if (args.dry_run) a.push('--dry-run')
      const r = await exec('argo', a, { timeout: 30000 })
      if (r.code !== 0) return { ok: false, text: `argo submit 失败：${r.stderr}` }
      return { ok: true, text: trimOutput(r.stdout) }
    },
  })

  register({
    name: 'ops_argowf_retry',
    description: '重试失败的工作流（重跑失败和错误的步骤）。先用 ops_argowf_diagnose 确认原因。',
    parameters: {
      instance: { type: 'string', description: '实例名称', required: true },
      name: { type: 'string', description: '工作流名称', required: true },
      namespace: { type: 'string', description: '命名空间' },
    },
    output: textOutput,
    async execute(args) {
      const inst = findInstance(args.instance)
      if (!inst) return { ok: false, text: `未找到实例 ${args.instance}` }
      const a = buildArgoArgs(inst, ['retry', args.name])
      if (args.namespace) { a.splice(a.indexOf('-n'), 2); a.push('-n', args.namespace) }
      const r = await exec('argo', a, { timeout: 30000 })
      if (r.code !== 0) return { ok: false, text: `argo retry 失败：${r.stderr}` }
      return { ok: true, text: trimOutput(r.stdout) }
    },
  })

  register({
    name: 'ops_argowf_stop',
    description: '停止运行中的工作流（会运行 onExit 处理器）。',
    parameters: {
      instance: { type: 'string', description: '实例名称', required: true },
      name: { type: 'string', description: '工作流名称', required: true },
      namespace: { type: 'string', description: '命名空间' },
    },
    output: textOutput,
    async execute(args) {
      const inst = findInstance(args.instance)
      if (!inst) return { ok: false, text: `未找到实例 ${args.instance}` }
      const a = buildArgoArgs(inst, ['stop', args.name])
      if (args.namespace) { a.splice(a.indexOf('-n'), 2); a.push('-n', args.namespace) }
      const r = await exec('argo', a, { timeout: 30000 })
      if (r.code !== 0) return { ok: false, text: `argo stop 失败：${r.stderr}` }
      return { ok: true, text: r.stdout || `已停止 ${args.name}` }
    },
  })

  register({
    name: 'ops_argowf_instances',
    description: '管理 Argo Workflows 实例（列出/添加/删除）。',
    parameters: {
      action: { type: 'string', enum: ['list', 'add', 'remove'], description: '操作（默认 list）' },
      name: { type: 'string', description: 'add/remove 时的实例名称' },
      server: { type: 'string', description: 'add 时的服务器地址' },
      namespace: { type: 'string', description: 'add 时的默认命名空间' },
    },
    output: textOutput,
    async execute(args) {
      const action = args.action || 'list'
      if (action === 'list') {
        const instances = loadInstances()
        if (!instances.length) return { ok: true, text: '没有已保存的 Argo Workflows 实例。用 ops_argowf_instances action=add 添加。' }
        const lines = instances.map((i) =>
          `${i.name}  server=${i.server}  ns=${i.namespace}` +
          (i.tags?.length ? `  [${i.tags.join(', ')}]` : '') +
          (i.note ? `  — ${i.note}` : '')
        )
        return { ok: true, text: lines.join('\n') }
      }
      if (action === 'add') {
        if (!args.name || !args.server) return { ok: false, text: '需要 name 和 server 参数' }
        const r = addInstance({ name: args.name, server: args.server, namespace: args.namespace })
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
