import { exec, trimOutput } from '../cli.mjs'
import { loadContexts, findContext, addContext, removeContext, buildKubectlArgs } from './context.mjs'

export function registerK8sTools(ctx, defineTool, toolsSvc, config) {
  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
  }
  const register = (tool) => toolsSvc.register(defineTool(tool))

  register({
    name: 'ops_kube_get',
    description: '列出或获取 Kubernetes 资源。不指定 name 时列出所有资源（表格），指定 name 时返回 YAML。',
    parameters: {
      context: { type: 'string', description: 'kubectl context 名称', required: true },
      kind: { type: 'string', description: '资源类型，如 pods、deployments、services', required: true },
      name: { type: 'string', description: '资源名称（可选，不填则列出所有）' },
      namespace: { type: 'string', description: '命名空间（可选）' },
      all_namespaces: { type: 'boolean', description: '是否查看所有命名空间' },
      label_selector: { type: 'string', description: '标签选择器，如 app=web' },
      output: { type: 'string', description: '输出格式：wide / yaml / json（默认无，表格）' },
    },
    output: textOutput,
    async execute(args) {
      const c = findContext(args.context)
      const kubectlArgs = c ? buildKubectlArgs(c, []) : ['--context', args.context]
      kubectlArgs.push('get', args.kind)
      if (args.name) kubectlArgs.push(args.name)
      if (args.namespace) kubectlArgs.push('-n', args.namespace)
      else if (c?.namespace) kubectlArgs.push('-n', c.namespace)
      if (args.all_namespaces) kubectlArgs.push('-A')
      if (args.label_selector) kubectlArgs.push('-l', args.label_selector)
      if (args.name && !args.output) kubectlArgs.push('-o', 'yaml')
      else if (args.output) kubectlArgs.push('-o', args.output)
      const r = await exec('kubectl', kubectlArgs, { timeout: 30000 })
      if (r.code !== 0) return { ok: false, text: `kubectl get 失败：${r.stderr || `exit ${r.code}`}` }
      return { ok: true, text: trimOutput(r.stdout) }
    },
  })

  register({
    name: 'ops_kube_describe',
    description: '显示 Kubernetes 资源的详细信息（条件、事件、容器状态等）。',
    parameters: {
      context: { type: 'string', description: 'kubectl context 名称', required: true },
      kind: { type: 'string', description: '资源类型', required: true },
      name: { type: 'string', description: '资源名称', required: true },
      namespace: { type: 'string', description: '命名空间' },
    },
    output: textOutput,
    async execute(args) {
      const c = findContext(args.context)
      const kubectlArgs = c ? buildKubectlArgs(c, []) : ['--context', args.context]
      kubectlArgs.push('describe', args.kind, args.name)
      if (args.namespace) kubectlArgs.push('-n', args.namespace)
      else if (c?.namespace) kubectlArgs.push('-n', c.namespace)
      const r = await exec('kubectl', kubectlArgs, { timeout: 30000 })
      if (r.code !== 0) return { ok: false, text: `kubectl describe 失败：${r.stderr}` }
      return { ok: true, text: trimOutput(r.stdout) }
    },
  })

  register({
    name: 'ops_kube_logs',
    description: '查看 Pod 的日志。',
    parameters: {
      context: { type: 'string', description: 'kubectl context 名称', required: true },
      pod: { type: 'string', description: 'Pod 名称', required: true },
      namespace: { type: 'string', description: '命名空间' },
      container: { type: 'string', description: '容器名（多容器 Pod 需要指定）' },
      tail: { type: 'number', description: '显示最后 N 行，默认 200' },
      previous: { type: 'boolean', description: '查看上一次（已崩溃）容器的日志' },
      since: { type: 'string', description: '只显示多久以内的日志，如 10m、2h' },
    },
    output: textOutput,
    async execute(args) {
      const c = findContext(args.context)
      const kubectlArgs = c ? buildKubectlArgs(c, []) : ['--context', args.context]
      kubectlArgs.push('logs', args.pod)
      if (args.namespace) kubectlArgs.push('-n', args.namespace)
      else if (c?.namespace) kubectlArgs.push('-n', c.namespace)
      if (args.container) kubectlArgs.push('-c', args.container)
      kubectlArgs.push('--tail', String(args.tail || 200))
      if (args.previous) kubectlArgs.push('--previous')
      if (args.since) kubectlArgs.push(`--since=${args.since}`)
      const r = await exec('kubectl', kubectlArgs, { timeout: 30000 })
      if (r.code !== 0) return { ok: false, text: `kubectl logs 失败：${r.stderr}` }
      return { ok: true, text: trimOutput(r.stdout) }
    },
  })

  register({
    name: 'ops_kube_exec',
    description: '在容器内执行一条命令。',
    parameters: {
      context: { type: 'string', description: 'kubectl context 名称', required: true },
      pod: { type: 'string', description: 'Pod 名称', required: true },
      command: { type: 'string', description: '要执行的命令', required: true },
      namespace: { type: 'string', description: '命名空间' },
      container: { type: 'string', description: '容器名' },
      timeout: { type: 'number', description: '超时秒数，默认 60' },
    },
    output: textOutput,
    async execute(args) {
      const c = findContext(args.context)
      const kubectlArgs = c ? buildKubectlArgs(c, []) : ['--context', args.context]
      kubectlArgs.push('exec', args.pod)
      if (args.namespace) kubectlArgs.push('-n', args.namespace)
      else if (c?.namespace) kubectlArgs.push('-n', c.namespace)
      if (args.container) kubectlArgs.push('-c', args.container)
      kubectlArgs.push('--', 'sh', '-c', args.command)
      const r = await exec('kubectl', kubectlArgs, { timeout: (args.timeout || 60) * 1000 })
      return {
        ok: r.code === 0,
        text: trimOutput(`[exit ${r.code}]\n${r.stdout}${r.stderr ? '\nstderr: ' + r.stderr : ''}`),
      }
    },
  })

  register({
    name: 'ops_kube_apply',
    description: '应用 YAML 清单到集群（默认 dry-run，需显式设 dry_run=false 才真正执行）。',
    parameters: {
      context: { type: 'string', description: 'kubectl context 名称', required: true },
      manifest: { type: 'string', description: 'YAML 清单内容', required: true },
      namespace: { type: 'string', description: '命名空间' },
      dry_run: { type: 'boolean', description: '是否只做 dry-run（默认 true）' },
    },
    output: textOutput,
    async execute(args) {
      const c = findContext(args.context)
      const kubectlArgs = c ? buildKubectlArgs(c, []) : ['--context', args.context]
      kubectlArgs.push('apply', '-f', '-')
      if (args.namespace) kubectlArgs.push('-n', args.namespace)
      else if (c?.namespace) kubectlArgs.push('-n', c.namespace)
      if (args.dry_run !== false) kubectlArgs.push('--dry-run=server')
      kubectlArgs.push('--server-side')
      const r = await exec('kubectl', kubectlArgs, { timeout: 30000, stdin: args.manifest })
      const prefix = args.dry_run !== false ? '[dry-run] ' : ''
      if (r.code !== 0) return { ok: false, text: `${prefix}kubectl apply 失败：${r.stderr}` }
      return { ok: true, text: trimOutput(`${prefix}${r.stdout}`) }
    },
  })

  register({
    name: 'ops_kube_delete',
    description: '删除一个 Kubernetes 资源。',
    parameters: {
      context: { type: 'string', description: 'kubectl context 名称', required: true },
      kind: { type: 'string', description: '资源类型', required: true },
      name: { type: 'string', description: '资源名称', required: true },
      namespace: { type: 'string', description: '命名空间' },
    },
    output: textOutput,
    async execute(args) {
      const c = findContext(args.context)
      const kubectlArgs = c ? buildKubectlArgs(c, []) : ['--context', args.context]
      kubectlArgs.push('delete', args.kind, args.name)
      if (args.namespace) kubectlArgs.push('-n', args.namespace)
      else if (c?.namespace) kubectlArgs.push('-n', c.namespace)
      const r = await exec('kubectl', kubectlArgs, { timeout: 30000 })
      if (r.code !== 0) return { ok: false, text: `kubectl delete 失败：${r.stderr}` }
      return { ok: true, text: r.stdout || `已删除 ${args.kind}/${args.name}` }
    },
  })

  register({
    name: 'ops_kube_scale',
    description: '调整 Deployment/StatefulSet/ReplicaSet 的副本数。',
    parameters: {
      context: { type: 'string', description: 'kubectl context 名称', required: true },
      kind: { type: 'string', description: '资源类型（deployment/statefulset/replicaset）', required: true },
      name: { type: 'string', description: '资源名称', required: true },
      replicas: { type: 'number', description: '目标副本数', required: true },
      namespace: { type: 'string', description: '命名空间' },
    },
    output: textOutput,
    async execute(args) {
      const c = findContext(args.context)
      const kubectlArgs = c ? buildKubectlArgs(c, []) : ['--context', args.context]
      kubectlArgs.push('scale', `${args.kind}/${args.name}`, `--replicas=${args.replicas}`)
      if (args.namespace) kubectlArgs.push('-n', args.namespace)
      else if (c?.namespace) kubectlArgs.push('-n', c.namespace)
      const r = await exec('kubectl', kubectlArgs, { timeout: 30000 })
      if (r.code !== 0) return { ok: false, text: `kubectl scale 失败：${r.stderr}` }
      return { ok: true, text: r.stdout || `已缩放 ${args.kind}/${args.name} → ${args.replicas}` }
    },
  })

  register({
    name: 'ops_kube_rollout',
    description: '管理滚动更新：查看状态、重启、暂停、恢复、回滚。',
    parameters: {
      context: { type: 'string', description: 'kubectl context 名称', required: true },
      action: { type: 'string', enum: ['status', 'restart', 'pause', 'resume', 'undo'], description: '操作', required: true },
      kind: { type: 'string', description: '资源类型（deployment/statefulset/daemonset）', required: true },
      name: { type: 'string', description: '资源名称', required: true },
      namespace: { type: 'string', description: '命名空间' },
      to_revision: { type: 'number', description: 'undo 时回滚到的版本号（可选）' },
    },
    output: textOutput,
    async execute(args) {
      const c = findContext(args.context)
      const kubectlArgs = c ? buildKubectlArgs(c, []) : ['--context', args.context]
      kubectlArgs.push('rollout', args.action, `${args.kind}/${args.name}`)
      if (args.namespace) kubectlArgs.push('-n', args.namespace)
      else if (c?.namespace) kubectlArgs.push('-n', c.namespace)
      if (args.action === 'undo' && args.to_revision) {
        kubectlArgs.push(`--to-revision=${args.to_revision}`)
      }
      const r = await exec('kubectl', kubectlArgs, { timeout: 60000 })
      if (r.code !== 0) return { ok: false, text: `kubectl rollout ${args.action} 失败：${r.stderr}` }
      return { ok: true, text: trimOutput(r.stdout) }
    },
  })

  register({
    name: 'ops_kube_events',
    description: '查看集群事件（默认只看 Warning 类型的最近事件）。',
    parameters: {
      context: { type: 'string', description: 'kubectl context 名称', required: true },
      namespace: { type: 'string', description: '命名空间' },
      all_namespaces: { type: 'boolean', description: '查看所有命名空间' },
      type: { type: 'string', enum: ['Warning', 'Normal'], description: '事件类型过滤' },
    },
    output: textOutput,
    async execute(args) {
      const c = findContext(args.context)
      const kubectlArgs = c ? buildKubectlArgs(c, []) : ['--context', args.context]
      kubectlArgs.push('get', 'events', '--sort-by=.lastTimestamp')
      if (args.namespace) kubectlArgs.push('-n', args.namespace)
      else if (c?.namespace && !args.all_namespaces) kubectlArgs.push('-n', c.namespace)
      if (args.all_namespaces) kubectlArgs.push('-A')
      if (args.type) kubectlArgs.push(`--field-selector=type=${args.type}`)
      const r = await exec('kubectl', kubectlArgs, { timeout: 30000 })
      if (r.code !== 0) return { ok: false, text: `kubectl get events 失败：${r.stderr}` }
      return { ok: true, text: trimOutput(r.stdout) }
    },
  })

  register({
    name: 'ops_kube_top',
    description: '查看 Pod 或 Node 的资源用量（需要 metrics-server）。',
    parameters: {
      context: { type: 'string', description: 'kubectl context 名称', required: true },
      kind: { type: 'string', enum: ['pods', 'nodes'], description: 'pods 或 nodes', required: true },
      namespace: { type: 'string', description: '命名空间（仅 pods）' },
      sort_by: { type: 'string', enum: ['cpu', 'memory'], description: '排序方式' },
    },
    output: textOutput,
    async execute(args) {
      const c = findContext(args.context)
      const kubectlArgs = c ? buildKubectlArgs(c, []) : ['--context', args.context]
      kubectlArgs.push('top', args.kind)
      if (args.kind === 'pods' && args.namespace) kubectlArgs.push('-n', args.namespace)
      else if (args.kind === 'pods' && c?.namespace) kubectlArgs.push('-n', c.namespace)
      if (args.sort_by) kubectlArgs.push(`--sort-by=${args.sort_by}`)
      const r = await exec('kubectl', kubectlArgs, { timeout: 30000 })
      if (r.code !== 0) return { ok: false, text: `kubectl top 失败：${r.stderr}` }
      return { ok: true, text: trimOutput(r.stdout) }
    },
  })

  register({
    name: 'ops_kube_contexts',
    description: '列出已保存的 Kubernetes 上下文，或从 kubeconfig 导入上下文。',
    parameters: {
      action: { type: 'string', enum: ['list', 'add', 'remove'], description: '操作（默认 list）' },
      name: { type: 'string', description: 'add/remove 时的上下文名称' },
      kubeconfig: { type: 'string', description: 'add 时的 kubeconfig 路径' },
      namespace: { type: 'string', description: 'add 时的默认命名空间' },
    },
    output: textOutput,
    async execute(args) {
      const action = args.action || 'list'
      if (action === 'list') {
        const contexts = loadContexts()
        if (!contexts.length) {
          const r = await exec('kubectl', ['config', 'get-contexts', '-o', 'name'], { timeout: 10000 })
          if (r.code === 0 && r.stdout) {
            return { ok: true, text: '没有已保存的上下文。系统 kubeconfig 中的上下文：\n' + r.stdout + '\n\n可以直接在 ops_kube_get 等工具中使用这些名称，或用 ops_kube_contexts action=add 保存。' }
          }
          return { ok: true, text: '没有已保存的上下文，也没有找到系统 kubeconfig。用 ops_kube_contexts action=add 添加。' }
        }
        const lines = contexts.map((c) =>
          `${c.name}  ns=${c.namespace}  kubeconfig=${c.kubeconfig}` +
          (c.tags?.length ? `  [${c.tags.join(', ')}]` : '') +
          (c.note ? `  — ${c.note}` : '')
        )
        return { ok: true, text: lines.join('\n') }
      }
      if (action === 'add') {
        if (!args.name) return { ok: false, text: '需要 name 参数' }
        const r = addContext({ name: args.name, kubeconfig: args.kubeconfig, namespace: args.namespace })
        return { ok: r.ok, text: r.ok ? `已添加上下文 ${args.name}` : r.why }
      }
      if (action === 'remove') {
        if (!args.name) return { ok: false, text: '需要 name 参数' }
        const r = removeContext(args.name)
        return { ok: r.ok, text: r.ok ? `已删除上下文 ${args.name}` : r.why }
      }
      return { ok: false, text: `未知操作 ${action}` }
    },
  })

  register({
    name: 'ops_kube_overview',
    description: '获取集群概览：节点数、Pod 状态、Deployment 数、命名空间数、近期 Warning 事件。',
    parameters: {
      context: { type: 'string', description: 'kubectl context 名称', required: true },
    },
    output: textOutput,
    async execute(args) {
      const c = findContext(args.context)
      const base = c ? buildKubectlArgs(c, []) : ['--context', args.context]
      const run = (extra) => exec('kubectl', [...base, ...extra], { timeout: 30000 })
      const [nodesR, podsR, depsR, nsR, evtR] = await Promise.all([
        run(['get', 'nodes', '-o', 'json']),
        run(['get', 'pods', '-A', '-o', 'json']),
        run(['get', 'deployments', '-A', '-o', 'json']),
        run(['get', 'namespaces', '-o', 'json']),
        run(['get', 'events', '-A', '--field-selector=type=Warning', '--sort-by=.lastTimestamp', '-o', 'json']),
      ])
      const parse = (r) => { try { return JSON.parse(r.stdout) } catch { return { items: [] } } }
      const nodes = parse(nodesR).items || []
      const pods = parse(podsR).items || []
      const deps = parse(depsR).items || []
      const nss = parse(nsR).items || []
      const evts = (parse(evtR).items || []).slice(0, 10)

      const running = pods.filter(p => p.status?.phase === 'Running').length
      const lines = [
        `节点: ${nodes.length}`,
        `Pod: ${running}/${pods.length} 运行中`,
        `Deployment: ${deps.length}`,
        `命名空间: ${nss.length} (${nss.map(n => n.metadata?.name).filter(Boolean).join(', ')})`,
      ]
      if (evts.length) {
        lines.push(`\n最近 Warning 事件 (${evts.length}):`)
        for (const e of evts) {
          lines.push(`  ${e.reason} — ${e.involvedObject?.kind}/${e.involvedObject?.name}: ${(e.message || '').slice(0, 120)}`)
        }
      }
      return { ok: true, text: lines.join('\n') }
    },
  })
}
