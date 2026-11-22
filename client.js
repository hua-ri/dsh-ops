/**
 * dsh-ops —— 浏览器端：设置页面板
 *
 * 挂载点：settings.section（左侧导航出现「运维工具」）
 * 读后端 /api/dsh-ops/status 获取模块状态和依赖检查结果。
 */
;(function() {

window.__ModuleLoader__.load({
  id: 'dsh-ops',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/dsh-ops'

    const asJson = async (res) => {
      if (res.ok) return res.json()
      throw new Error('HTTP ' + res.status)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-ops-page]{font-size:14px;padding:0 4px;}
[data-ops-title]{font-size:18px;font-weight:600;margin-bottom:16px;}
[data-ops-section]{margin-bottom:20px;}
[data-ops-section-title]{font-size:15px;font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:8px;}
[data-ops-card]{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));border-radius:8px;margin-bottom:8px;background:var(--dsw-alias-bg2,rgba(255,255,255,.04));}
[data-ops-card-info]{flex:1;}
[data-ops-card-name]{font-weight:600;font-size:14px;}
[data-ops-card-desc]{font-size:12px;color:var(--dsw-alias-fg3,#999);margin-top:2px;}
[data-ops-card-dep]{font-size:11px;margin-top:4px;display:flex;align-items:center;gap:6px;}
[data-ops-badge]{display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:500;}
[data-ops-badge-ok]{background:#dcfce7;color:#166534;}
[data-ops-badge-miss]{background:#fee2e2;color:#991b1b;}
[data-ops-badge-off]{background:#f3f4f6;color:#6b7280;}
[data-ops-toggle]{position:relative;display:inline-flex;align-items:center;width:40px;height:22px;border-radius:11px;cursor:pointer;transition:background .2s;border:none;padding:0;}
[data-ops-toggle][data-on="true"]{background:#3b82f6;}
[data-ops-toggle][data-on="false"]{background:#d1d5db;}
[data-ops-toggle-dot]{position:absolute;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .2s;top:2px;}
[data-ops-toggle][data-on="true"] [data-ops-toggle-dot]{left:20px;}
[data-ops-toggle][data-on="false"] [data-ops-toggle-dot]{left:2px;}
[data-ops-hint]{font-size:12px;color:var(--dsw-alias-fg3,#999);margin-top:12px;padding:8px 12px;background:var(--dsw-alias-bg2,rgba(255,255,255,.04));border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.12));}
[data-ops-stats]{display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap;}
[data-ops-stat]{padding:8px 16px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));background:var(--dsw-alias-bg2,rgba(255,255,255,.04));text-align:center;min-width:80px;}
[data-ops-stat-num]{font-size:20px;font-weight:700;color:var(--dsw-alias-fg1,#111);}
[data-ops-stat-label]{font-size:11px;color:var(--dsw-alias-fg3,#999);margin-top:2px;}
`

    const MODULES = [
      { key: 'ssh', label: 'SSH', desc: '远程主机管理与命令执行', bin: 'ssh', defaultOn: true },
      { key: 'k8s', label: 'Kubernetes', desc: 'kubectl 集群管理', bin: 'kubectl', defaultOn: true },
      { key: 'argocd', label: 'Argo CD', desc: 'GitOps 持续部署', bin: 'argocd', defaultOn: false },
      { key: 'argowf', label: 'Argo Workflows', desc: '工作流引擎管理', bin: 'argo', defaultOn: false },
    ]

    function Icon({ size = 16 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true,
      },
        h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }),
        h('path', { d: 'M7 8h4M7 12h6M7 16h3' }),
        h('circle', { cx: 17, cy: 12, r: 2 }),
      )
    }

    function Toggle({ on, onChange }) {
      return h('button', {
        'data-ops-toggle': true, 'data-on': String(!!on),
        onClick: () => onChange(!on),
      }, h('span', { 'data-ops-toggle-dot': true }))
    }

    function ModuleCard({ mod, status, onToggle }) {
      const dep = status?.deps?.[mod.bin]
      const enabled = status?.config?.[mod.key]?.enabled ?? mod.defaultOn
      return h('div', { 'data-ops-card': true }, [
        h('div', { 'data-ops-card-info': true }, [
          h('div', { 'data-ops-card-name': true }, mod.label),
          h('div', { 'data-ops-card-desc': true }, mod.desc),
          h('div', { 'data-ops-card-dep': true }, [
            h('code', { style: { fontSize: '11px' } }, mod.bin),
            dep?.ok
              ? h('span', { 'data-ops-badge': true, 'data-ops-badge-ok': true }, dep.path || 'OK')
              : !enabled
                ? h('span', { 'data-ops-badge': true, 'data-ops-badge-off': true }, '未启用')
                : h('span', { 'data-ops-badge': true, 'data-ops-badge-miss': true }, '未安装'),
          ]),
        ]),
        h(Toggle, { on: enabled, onChange: (v) => onToggle(mod.key, v) }),
      ])
    }

    function Panel() {
      const [status, setStatus] = React.useState(null)
      const [saving, setSaving] = React.useState(false)

      const refresh = React.useCallback(() => {
        jget('/status').then(setStatus).catch(() => setStatus({ error: true }))
      }, [])

      React.useEffect(() => { refresh() }, [refresh])

      const toggleModule = React.useCallback(async (key, on) => {
        setSaving(true)
        try {
          await jpost('/config', { module: key, enabled: on })
          refresh()
        } catch {}
        setSaving(false)
      }, [refresh])

      if (!status) return h('div', { 'data-ops-page': true }, '加载中…')
      if (status.error) return h('div', { 'data-ops-page': true }, '无法连接后端。请确认 dsh-ops 插件已启用。')

      const enabledCount = MODULES.filter((m) => status.config?.[m.key]?.enabled ?? m.defaultOn).length
      const depOkCount = Object.values(status.deps || {}).filter((d) => d.ok).length

      return h('div', { 'data-ops-page': true }, [
        h('div', { 'data-ops-title': true }, '运维工具'),

        h('div', { 'data-ops-stats': true }, [
          h('div', { 'data-ops-stat': true }, [
            h('div', { 'data-ops-stat-num': true }, String(enabledCount)),
            h('div', { 'data-ops-stat-label': true }, '已启用模块'),
          ]),
          h('div', { 'data-ops-stat': true }, [
            h('div', { 'data-ops-stat-num': true }, String(depOkCount) + '/' + String(MODULES.length)),
            h('div', { 'data-ops-stat-label': true }, 'CLI 就绪'),
          ]),
          h('div', { 'data-ops-stat': true }, [
            h('div', { 'data-ops-stat-num': true }, String(status.toolCount || 0)),
            h('div', { 'data-ops-stat-label': true }, '已注册工具'),
          ]),
        ]),

        h('div', { 'data-ops-section': true }, [
          h('div', { 'data-ops-section-title': true }, '模块管理'),
          ...MODULES.map((m) => h(ModuleCard, {
            key: m.key, mod: m, status, onToggle: toggleModule,
          })),
        ]),

        h('div', { 'data-ops-hint': true }, [
          '开关切换后需要重启 DSH 才生效。数据目录：~/.dsh/dsh-ops/',
        ]),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-ops')
        style.textContent = CSS
        document.head.appendChild(style)
        if (typeof ctx.effect === 'function') ctx.effect(() => () => style.remove(), 'dsh-ops: 面板样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return

        slots.inject('sidebar.panellist', () => {
          slots.register(
            { name: 'sidebar.panellist', id: 'dsh-ops', order: 25, label: '运维工具' },
            Icon,
          )
        })

        slots.inject('main', () => {
          slots.register({ name: 'main', key: 'dsh-ops' }, Panel)
        })
      },
    }
  },
})

})();
