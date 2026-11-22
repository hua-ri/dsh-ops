(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const json = v => JSON.stringify(v, null, 2);
  const API = '/api/dsh-ops';

  const pages = [
    ['dashboard', '◈', '仪表盘'],
    ['hosts',     '⌘', '主机'],
    ['k8s',       '⎈', 'Kubernetes'],
    ['argocd',    '⟳', 'Argo CD'],
    ['argowf',    '▶', 'Workflows'],
    ['settings',  '⚙', '设置'],
  ];

  let page = 'dashboard', generation = 0, toastTimer, meta = null;
  const cmdHistory = [];

  async function fetchJSON(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const signal = options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal;
      const response = await fetch(url, { credentials: 'same-origin', ...options, signal });
      const text = await response.text();
      let value;
      try { value = JSON.parse(text); } catch {
        throw new Error(response.ok ? '服务器未返回 JSON' : `请求失败 (${response.status})`);
      }
      if (!response.ok) throw new Error(value.error || `请求失败 (${response.status})`);
      return value;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('请求超时');
      throw e;
    } finally { clearTimeout(timeout); }
  }

  function postJSON(url, body) {
    return fetchJSON(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function deleteJSON(url) {
    return fetchJSON(url, { method: 'DELETE' });
  }

  function putJSON(url, body) {
    return fetchJSON(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function toast(text) {
    $('toast').textContent = text;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').hidden = true, 4000);
  }

  function title(name, en, subtitle, action = '') {
    return `<div class="title-row"><div><div class="eyebrow">${en}</div><h1>${name}</h1><p class="subtitle">${subtitle}</p></div>${action}</div>`;
  }
  function loading() { return '<div class="loading">正在加载</div>'; }
  function errorHTML(e) { return `<div class="notice error">${esc(e.message || e)}</div>`; }
  function empty(msg) { return `<div class="empty">${esc(msg || '暂无数据')}</div>`; }

  function statusBadge(status) {
    const map = { Synced: 'ok', Healthy: 'ok', Running: 'ok', Succeeded: 'ok', true: 'ok', OutOfSync: 'warn', Progressing: 'warn', Degraded: 'err', Failed: 'err', Error: 'err', Missing: 'err', false: 'err', Unknown: 'off' };
    return `<span class="badge badge-${map[status] || 'off'}">${esc(status)}</span>`;
  }

  function tabs(items, active, onClickAttr) {
    return `<div class="command-tabs">${items.map(([key, label]) =>
      `<button class="chip ${active === key ? 'active' : ''}" ${onClickAttr}="${esc(key)}">${esc(label)}</button>`
    ).join('')}</div>`;
  }

  // ---- MODULES DATA ----
  const MODULES = [
    { key: 'ssh', label: 'SSH', desc: '远程主机管理与命令执行', bin: 'ssh' },
    { key: 'k8s', label: 'Kubernetes', desc: 'kubectl 集群管理', bin: 'kubectl' },
    { key: 'argocd', label: 'Argo CD', desc: 'GitOps 持续部署', bin: 'argocd' },
    { key: 'argowf', label: 'Argo Workflows', desc: '工作流引擎管理', bin: 'argo' },
  ];

  // ============================================================
  // DASHBOARD
  // ============================================================
  async function dashboard(token) {
    $('main').innerHTML = loading();
    let status, hostCount = '—';
    try { status = await fetchJSON(API + '/status'); } catch (e) {
      if (token === generation) $('main').innerHTML = title('仪表盘', 'DASHBOARD', '运维工具总览') + errorHTML(e);
      return;
    }
    if (token !== generation) return;
    meta = status;

    try { const hosts = await fetchJSON(API + '/ssh/hosts'); hostCount = hosts.length; } catch { hostCount = '—'; }
    if (token !== generation) return;

    const enabledCount = MODULES.filter(m => status.config?.[m.key]?.enabled !== false && (m.key === 'ssh' || m.key === 'k8s' ? true : status.config?.[m.key]?.enabled)).length;
    const depOk = Object.values(status.deps || {}).filter(d => d.ok).length;

    $('main').innerHTML = title('仪表盘', 'DASHBOARD', '运维工具总览') +
      `<div class="stats">
        <div class="stat"><div class="stat-label">已启用模块</div><div class="stat-value">${enabledCount}</div><div class="stat-note">共 ${MODULES.length} 个模块</div></div>
        <div class="stat"><div class="stat-label">CLI 就绪</div><div class="stat-value">${depOk}/${MODULES.length}</div><div class="stat-note">依赖二进制</div></div>
        <div class="stat"><div class="stat-label">已注册工具</div><div class="stat-value">${status.toolCount || 0}</div><div class="stat-note">MCP 工具</div></div>
        <div class="stat"><div class="stat-label">SSH 主机</div><div class="stat-value">${esc(String(hostCount))}</div><div class="stat-note">已保存</div></div>
      </div>` +
      `<div class="grid-two">
        <section class="panel"><div class="panel-head"><h3>模块状态</h3></div>
          ${MODULES.map(m => {
            const dep = status.deps?.[m.bin];
            const enabled = m.key === 'ssh' || m.key === 'k8s' ? status.config?.[m.key]?.enabled !== false : !!status.config?.[m.key]?.enabled;
            return `<div class="row-item"><span class="row-dot" style="background:${enabled ? (dep?.ok ? 'var(--success)' : 'var(--warning)') : 'var(--muted)'};border-color:transparent"></span>
              <div class="row-content"><div class="row-title">${esc(m.label)}</div>
              <div class="row-meta"><span>${esc(m.desc)}</span>${dep?.ok ? `<span class="badge badge-ok">${esc(dep.path)}</span>` : enabled ? '<span class="badge badge-err">CLI 未安装</span>' : '<span class="badge badge-off">未启用</span>'}</div></div></div>`;
          }).join('')}
        </section>
        <div>
          <section class="panel"><div class="panel-head"><h3>快捷操作</h3></div><div class="panel-body">
            <div class="quick-actions">
              <button class="button quick-action" data-page="hosts">主机管理 <span>↗</span></button>
              <button class="button quick-action" data-page="k8s">Kubernetes <span>↗</span></button>
              <button class="button quick-action" data-page="argocd">Argo CD <span>↗</span></button>
              <button class="button quick-action" data-page="argowf">Workflows <span>↗</span></button>
              <button class="button quick-action" data-page="settings">设置 <span>↗</span></button>
            </div>
          </div></section>
        </div>
      </div>`;

    document.querySelectorAll('[data-page]').forEach(b => b.onclick = () => navigate(b.dataset.page));
  }

  // ============================================================
  // SSH PAGE
  // ============================================================
  async function hostsPage(token) {
    let sshTab = 'hosts';
    let filesHost = '', filesPath = '~', filesShowHidden = false;
    let statsHost = '';
    const sshHosts = [];

    async function loadHosts() {
      try { const list = await fetchJSON(API + '/ssh/hosts'); sshHosts.length = 0; sshHosts.push(...list); } catch { sshHosts.length = 0; }
    }

    function hostOptions() {
      return sshHosts.map(h => `<option value="${esc(h.name)}">${esc(h.name)} (${esc(h.hostname)})</option>`).join('');
    }

    function switchToFiles(hostName) {
      filesHost = hostName;
      filesPath = '~';
      sshTab = 'files';
      renderPage();
    }

    function switchToStats(hostName) {
      statsHost = hostName;
      sshTab = 'stats';
      renderPage();
    }

    function renderPage() {
      if (token !== generation) return;

      $('main').innerHTML = title('主机', 'HOST MANAGEMENT', '远程主机管理、命令执行、文件浏览') +
        tabs([['hosts', '主机'], ['exec', '执行'], ['batch', '批量'], ['snippets', '片段'], ['keys', '密钥'], ['tunnels', '隧道'], ['files', '文件'], ['stats', '监控']], sshTab, 'data-ssh-tab') +
        '<div id="ssh-content"></div>';

      document.querySelectorAll('[data-ssh-tab]').forEach(b => b.onclick = () => { sshTab = b.dataset.sshTab; renderPage(); });

      if (sshTab === 'hosts') renderHosts();
      else if (sshTab === 'exec') renderExec();
      else if (sshTab === 'batch') renderBatch();
      else if (sshTab === 'snippets') renderSnippets();
      else if (sshTab === 'keys') renderKeys();
      else if (sshTab === 'tunnels') renderTunnels();
      else if (sshTab === 'files') renderFiles();
      else if (sshTab === 'stats') renderStats();
    }

    function renderHosts() {
      const c = $('ssh-content');
      c.innerHTML =
        `<div class="toolbar">
          <button id="add-host-btn" class="button primary">＋ 添加主机</button>
          <button id="import-host-btn" class="button">📥 导入 SSH Config</button>
          <button id="ping-all-btn" class="button">🏓 批量测延迟</button>
          <input id="host-filter" class="search" placeholder="搜索主机…">
        </div>` +
        `<section id="add-host-form" class="panel" hidden><div class="panel-head"><h3 id="host-form-title">添加主机</h3></div>
          <form id="host-form" class="panel-body form-grid">
            <input type="hidden" name="_edit" value="">
            <div class="form-inline">
              <label>名称 *<input name="name" required placeholder="my-server"></label>
              <label>主机名 *<input name="hostname" required placeholder="192.168.1.1 或 example.com"></label>
            </div>
            <div class="form-inline">
              <label>端口<input name="port" type="number" value="22" min="1" max="65535"></label>
              <label>用户<input name="user" placeholder="root"></label>
            </div>
            <label>密钥文件<input name="identity_file" placeholder="~/.ssh/id_rsa"></label>
            <label>连接方式<select name="connect_mode" id="connect-mode">
              <option value="direct">直连</option>
              <option value="proxy">ProxyJump（TCP 转发）</option>
              <option value="relay">中继主机（跳板 SSH）</option>
            </select></label>
            <div id="connect-hint" class="muted" style="font-size:11px;line-height:1.4"></div>
            <div id="connect-extra"></div>
            <div class="form-inline">
              <label>标签<input name="tags" placeholder="env=prod, role=web"></label>
              <label>备注<input name="note" placeholder="可选备注"></label>
            </div>
            <div class="actions"><button type="button" id="cancel-host" class="button">取消</button><button type="submit" class="button primary">保存</button></div>
          </form></section>` +
        `<section id="import-preview" class="panel" hidden><div class="panel-head"><h3>SSH Config 预览</h3><button class="button" id="cancel-import">关闭</button></div>
          <div id="import-list" class="panel-body"></div>
          <div class="actions" style="padding:0 20px 16px"><button id="do-import" class="button primary">导入选中</button></div>
        </section>` +
        `<div id="host-list">${loading()}</div>`;

      $('add-host-btn').onclick = () => {
        const form = $('host-form');
        form.reset(); form._edit.value = '';
        $('host-form-title').textContent = '添加主机';
        form.name.disabled = false;
        $('add-host-form').hidden = !$('add-host-form').hidden;
        $('import-preview').hidden = true;
        updateConnectMode('direct');
      };
      $('cancel-host').onclick = () => { $('add-host-form').hidden = true; };
      $('host-filter').oninput = () => renderHostList($('host-filter').value);

      const CONNECT_HINTS = {
        direct: '直接 SSH 连接目标主机，无需中间节点',
        proxy: '本地有目标密钥，但网络不通需经跳板机转发。跳板机只转 TCP 流量，不接触认证密钥',
        relay: '本地无目标密钥，密钥在跳板机上。先 SSH 到跳板机，再由跳板机 SSH 到目标',
      };
      function updateConnectMode(mode) {
        $('connect-mode').value = mode;
        $('connect-hint').textContent = CONNECT_HINTS[mode] || '';
        if (mode === 'proxy') {
          $('connect-extra').innerHTML = '<label>跳板地址<input name="proxyJump" placeholder="user@jump-host:22"></label>';
        } else if (mode === 'relay') {
          $('connect-extra').innerHTML = `<label>中继主机<select name="relay">${sshHosts.map(h => `<option value="${esc(h.name)}">${esc(h.name)} (${esc(h.hostname)})</option>`).join('')}</select></label>`;
        } else {
          $('connect-extra').innerHTML = '';
        }
      }
      $('connect-mode').onchange = (e) => updateConnectMode(e.target.value);
      updateConnectMode('direct');

      $('host-form').onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const isEdit = fd.get('_edit');
        const body = { hostname: fd.get('hostname'), port: Number(fd.get('port')) || 22 };
        if (fd.get('user')) body.user = fd.get('user');
        if (fd.get('identity_file')) body.identityFile = fd.get('identity_file');
        const mode = fd.get('connect_mode');
        if (mode === 'proxy' && fd.get('proxyJump')) { body.proxyJump = fd.get('proxyJump'); body.relay = null; }
        else if (mode === 'relay' && fd.get('relay')) { body.relay = fd.get('relay'); body.proxyJump = null; }
        else { body.proxyJump = null; body.relay = null; }
        if (fd.get('tags')) body.tags = fd.get('tags').split(/[,，]/).map(s => s.trim()).filter(Boolean);
        if (fd.get('note')) body.note = fd.get('note');
        try {
          if (isEdit) {
            await putJSON(API + '/ssh/hosts/' + encodeURIComponent(isEdit), body);
            toast('主机已更新');
          } else {
            body.name = fd.get('name');
            await postJSON(API + '/ssh/hosts', body);
            toast('主机已添加');
          }
          $('add-host-form').hidden = true;
          e.target.reset();
          await loadHosts();
          renderHostList('');
        } catch (err) { toast(err.message); }
      };

      $('import-host-btn').onclick = async () => {
        $('add-host-form').hidden = true;
        $('import-preview').hidden = false;
        $('import-list').innerHTML = loading();
        try {
          const r = await fetchJSON(API + '/ssh/import-preview');
          if (!r.ok) { $('import-list').innerHTML = `<div class="notice error">${esc(r.error)}</div>`; return; }
          if (!r.hosts.length) { $('import-list').innerHTML = empty('SSH Config 中没有可导入的主机'); return; }
          $('import-list').innerHTML = r.hosts.map(h =>
            `<label class="row-item" style="cursor:pointer">
              <input type="checkbox" value="${esc(h.name)}" ${h.exists ? 'disabled' : 'checked'} style="margin-right:10px;accent-color:var(--accent)">
              <div class="row-content">
                <div class="row-title"><strong>${esc(h.name)}</strong>${h.exists ? ' <span class="badge badge-off">已存在</span>' : ''}</div>
                <div class="row-meta">
                  <span>${esc(h.user || '')}@${esc(h.hostname)}:${h.port || 22}</span>
                  ${h.proxyJump ? `<span class="badge badge-off">Jump: ${esc(h.proxyJump)}</span>` : ''}
                  ${h.identityFile ? `<span class="muted">${esc(h.identityFile)}</span>` : ''}
                </div>
              </div>
            </label>`
          ).join('');
        } catch (err) { $('import-list').innerHTML = errorHTML(err); }
      };
      $('cancel-import').onclick = () => { $('import-preview').hidden = true; };
      $('do-import').onclick = async () => {
        const checked = [...$('import-list').querySelectorAll('input:checked')].map(i => i.value);
        if (!checked.length) { toast('未选择主机'); return; }
        try {
          const r = await postJSON(API + '/ssh/import', { hosts: checked });
          toast(`成功导入 ${r.imported.length} 台` + (r.skipped.length ? `，跳过 ${r.skipped.length} 台` : ''));
          $('import-preview').hidden = true;
          await loadHosts();
          renderHostList('');
        } catch (err) { toast(err.message); }
      };

      $('ping-all-btn').onclick = async () => {
        const btn = $('ping-all-btn'); btn.disabled = true; btn.textContent = '测试中…';
        for (const h of sshHosts) {
          const badge = document.querySelector(`[data-latency="${h.name}"]`);
          if (badge) { badge.textContent = '…'; badge.className = 'badge badge-off'; }
          try {
            const r = await postJSON(API + '/ssh/hosts/' + encodeURIComponent(h.name) + '/ping', {});
            if (badge) {
              badge.textContent = r.ok ? r.latencyMs + 'ms' : '失败';
              badge.className = r.ok ? (r.latencyMs < 500 ? 'badge badge-ok' : r.latencyMs < 2000 ? 'badge badge-warn' : 'badge badge-err') : 'badge badge-err';
            }
          } catch { if (badge) { badge.textContent = '错误'; badge.className = 'badge badge-err'; } }
        }
        btn.disabled = false; btn.textContent = '🏓 批量测延迟';
      };

      loadHosts().then(() => renderHostList(''));
    }

    function renderHostList(filter) {
      const f = (filter || '').toLowerCase();
      const filtered = sshHosts.filter(h => !f || h.name.toLowerCase().includes(f) || h.hostname.toLowerCase().includes(f) || (h.tags || []).some(t => t.toLowerCase().includes(f)));
      const el = $('host-list');
      if (!el) return;
      if (!filtered.length) { el.innerHTML = empty(sshHosts.length ? '没有匹配的主机' : '还没有保存的主机。点击「添加主机」或「导入 SSH Config」开始。'); return; }

      const groups = {};
      filtered.forEach(h => {
        const g = (h.tags && h.tags.length) ? h.tags[0] : '未分组';
        (groups[g] = groups[g] || []).push(h);
      });

      const sortedKeys = Object.keys(groups).sort((a, b) => a === '未分组' ? 1 : b === '未分组' ? -1 : a.localeCompare(b));

      el.innerHTML = sortedKeys.map(g => {
        const items = groups[g];
        return `<div class="host-group">
          <div class="panel-head" style="cursor:pointer;user-select:none" data-toggle-group="${esc(g)}">
            <h3><span class="group-arrow" data-arrow="${esc(g)}">▾</span> ${esc(g)}</h3>
            <span class="badge badge-off">${items.length}</span>
          </div>
          <div data-group-body="${esc(g)}">
          ${items.map(h => `<div class="row-item">
            <span class="row-dot" style="border-color:var(--accent)"></span>
            <div class="row-content">
              <div class="row-title"><strong>${esc(h.name)}</strong> <span class="badge badge-off" data-latency="${esc(h.name)}">—</span></div>
              <div class="row-meta">
                <span>${esc(h.user || 'root')}@${esc(h.hostname)}:${h.port || 22}</span>
                ${h.proxyJump ? `<span class="badge badge-warn">Jump: ${esc(h.proxyJump)}</span>` : ''}
                ${h.relay ? `<span class="badge badge-warn">中继: ${esc(h.relay)}</span>` : ''}
                ${(h.tags || []).map(t => `<span class="badge badge-off">${esc(t)}</span>`).join('')}
                ${h.note ? `<span class="muted">${esc(h.note)}</span>` : ''}
              </div>
            </div>
            <div class="row-actions">
              <button class="button" data-ping-host="${esc(h.name)}">Ping</button>
              <button class="button" data-edit-host="${esc(h.name)}">编辑</button>
              <button class="button" data-test-host="${esc(h.name)}">测试</button>
              <button class="button" data-files-host="${esc(h.name)}">文件</button>
              <button class="button" data-stats-host="${esc(h.name)}">监控</button>
              <button class="button danger" data-del-host="${esc(h.name)}">删除</button>
            </div>
          </div>`).join('')}
          </div>
        </div>`
      }).join('');

      el.querySelectorAll('[data-toggle-group]').forEach(b => b.onclick = () => {
        const g = b.dataset.toggleGroup;
        const body = el.querySelector(`[data-group-body="${g}"]`);
        const arrow = el.querySelector(`[data-arrow="${g}"]`);
        if (body) { body.hidden = !body.hidden; if (arrow) arrow.textContent = body.hidden ? '▸' : '▾'; }
      });

      el.querySelectorAll('[data-ping-host]').forEach(b => b.onclick = async () => {
        const name = b.dataset.pingHost;
        const badge = el.querySelector(`[data-latency="${name}"]`);
        b.disabled = true;
        if (badge) { badge.textContent = '…'; badge.className = 'badge badge-off'; }
        try {
          const r = await postJSON(API + '/ssh/hosts/' + encodeURIComponent(name) + '/ping', {});
          if (badge) {
            badge.textContent = r.ok ? r.latencyMs + 'ms' : '失败';
            badge.className = r.ok ? (r.latencyMs < 500 ? 'badge badge-ok' : r.latencyMs < 2000 ? 'badge badge-warn' : 'badge badge-err') : 'badge badge-err';
          }
        } catch { if (badge) { badge.textContent = '错误'; badge.className = 'badge badge-err'; } }
        b.disabled = false;
      });

      el.querySelectorAll('[data-edit-host]').forEach(b => b.onclick = () => {
        const h = sshHosts.find(x => x.name === b.dataset.editHost);
        if (!h) return;
        $('add-host-form').hidden = false;
        $('import-preview').hidden = true;
        $('host-form-title').textContent = '编辑主机: ' + h.name;
        const form = $('host-form');
        form._edit.value = h.name;
        form.name.value = h.name; form.name.disabled = true;
        form.hostname.value = h.hostname || '';
        form.port.value = h.port || 22;
        form.user.value = h.user || '';
        form.identity_file.value = h.identityFile || '';
        if (h.relay) updateConnectMode('relay');
        else if (h.proxyJump) updateConnectMode('proxy');
        else updateConnectMode('direct');
        if (h.proxyJump && $('connect-extra').querySelector('[name=proxyJump]')) {
          $('connect-extra').querySelector('[name=proxyJump]').value = h.proxyJump;
        }
        if (h.relay && $('connect-extra').querySelector('[name=relay]')) {
          $('connect-extra').querySelector('[name=relay]').value = h.relay;
        }
        form.tags.value = (h.tags || []).join(', ');
        form.note.value = h.note || '';
        $('add-host-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });

      el.querySelectorAll('[data-test-host]').forEach(b => b.onclick = async () => {
        b.disabled = true; b.textContent = '测试中…';
        try {
          const r = await postJSON(API + '/ssh/hosts/' + encodeURIComponent(b.dataset.testHost) + '/test', {});
          toast(r.ok ? '连接成功: ' + (r.stdout || '').trim() : '连接失败: ' + (r.stderr || '').trim());
        } catch (err) { toast('测试失败: ' + err.message); }
        b.disabled = false; b.textContent = '测试';
      });

      el.querySelectorAll('[data-files-host]').forEach(b => b.onclick = () => {
        switchToFiles(b.dataset.filesHost);
      });

      el.querySelectorAll('[data-stats-host]').forEach(b => b.onclick = () => {
        switchToStats(b.dataset.statsHost);
      });

      el.querySelectorAll('[data-del-host]').forEach(b => b.onclick = async () => {
        if (!confirm('确认删除主机 ' + b.dataset.delHost + '？')) return;
        try {
          await deleteJSON(API + '/ssh/hosts/' + encodeURIComponent(b.dataset.delHost));
          toast('已删除');
          await loadHosts(); renderHostList($('host-filter')?.value || '');
        } catch (err) { toast(err.message); }
      });
    }

    function renderExec() {
      const c = $('ssh-content');
      c.innerHTML =
        `<section class="panel"><div class="panel-head"><h3>远程执行</h3></div><div class="panel-body form-grid">
          <div class="form-inline">
            <label>主机<select id="exec-host">${hostOptions()}</select></label>
            <label>超时 (秒)<input id="exec-timeout" type="number" value="60" min="1" max="600"></label>
          </div>
          <label>命令<textarea id="exec-cmd" placeholder="输入要执行的命令…" rows="3"></textarea></label>
          ${cmdHistory.length ? `<div class="command-tabs">${cmdHistory.slice(-10).map(c => `<button class="chip" data-hist-cmd>${esc(c.length > 40 ? c.slice(0, 37) + '…' : c)}</button>`).join('')}</div>` : ''}
          <div class="actions"><button id="exec-run" class="button primary">执行</button></div>
        </div></section>
        <div id="exec-result"></div>`;

      document.querySelectorAll('[data-hist-cmd]').forEach((b, i) => {
        b.onclick = () => { $('exec-cmd').value = cmdHistory[cmdHistory.length - 10 + i] || ''; };
      });

      $('exec-run').onclick = async () => {
        const host = $('exec-host').value;
        const command = $('exec-cmd').value.trim();
        if (!host || !command) { toast('请选择主机并输入命令'); return; }
        const timeout = Number($('exec-timeout').value) || 60;
        const btn = $('exec-run');
        btn.disabled = true; btn.textContent = '执行中…';
        $('exec-result').innerHTML = loading();

        if (!cmdHistory.includes(command)) { cmdHistory.push(command); if (cmdHistory.length > 20) cmdHistory.shift(); }

        try {
          const r = await postJSON(API + '/ssh/exec', { host, command, timeout });
          $('exec-result').innerHTML =
            `<section class="panel"><div class="panel-head"><h3>执行结果</h3>
              <span class="badge badge-${r.code === 0 ? 'ok' : 'err'}">exit ${r.code}</span></div>
              <div class="panel-body">
                ${r.stdout ? `<div class="eyebrow">stdout</div><pre>${esc(r.stdout)}</pre>` : ''}
                ${r.stderr ? `<div class="eyebrow" style="margin-top:12px;color:var(--danger)">stderr</div><pre style="color:var(--danger)">${esc(r.stderr)}</pre>` : ''}
                ${!r.stdout && !r.stderr ? '<div class="muted">无输出</div>' : ''}
              </div></section>`;
        } catch (err) { $('exec-result').innerHTML = errorHTML(err); }
        btn.disabled = false; btn.textContent = '执行';
      };
    }

    function renderBatch() {
      const c = $('ssh-content');
      c.innerHTML =
        `<section class="panel"><div class="panel-head"><h3>批量执行</h3></div><div class="panel-body form-grid">
          <div class="eyebrow">选择主机</div>
          <div id="batch-hosts" class="command-tabs">${sshHosts.map(h =>
            `<label class="chip"><input type="checkbox" value="${esc(h.name)}" checked style="margin-right:6px">${esc(h.name)}</label>`
          ).join('') || '<span class="muted">无可用主机</span>'}</div>
          <label>命令<textarea id="batch-cmd" placeholder="输入要在所有选中主机上执行的命令…" rows="3"></textarea></label>
          <div class="form-inline">
            <label class="toggle-row"><input type="checkbox" id="batch-canary" checked> Canary 模式（首台单独执行）</label>
            <label class="toggle-row"><input type="checkbox" id="batch-stop" checked> 失败时停止后续</label>
          </div>
          <div class="form-inline">
            <label>并发数<input id="batch-concurrency" type="number" value="1" min="1" max="20" style="width:80px"></label>
            <span class="muted" style="font-size:11px;align-self:end;padding-bottom:8px">1 = 顺序执行，>1 = 并行</span>
          </div>
          <div class="actions"><button id="batch-run" class="button primary">批量执行</button></div>
        </div></section>
        <div id="batch-result"></div>`;

      $('batch-run').onclick = async () => {
        const checked = [...document.querySelectorAll('#batch-hosts input:checked')].map(i => i.value);
        const command = $('batch-cmd').value.trim();
        if (!checked.length || !command) { toast('请选择主机并输入命令'); return; }
        const btn = $('batch-run');
        btn.disabled = true; btn.textContent = '执行中…';
        $('batch-result').innerHTML = loading();

        try {
          const r = await postJSON(API + '/ssh/batch', {
            hosts: checked, command,
            canary: $('batch-canary').checked,
            stop_on_failure: $('batch-stop').checked,
            concurrency: Number($('batch-concurrency').value) || 1,
          });
          const results = r.results || [];
          $('batch-result').innerHTML =
            `<section class="panel"><div class="panel-head"><h3>批量结果</h3><span class="badge badge-off">${results.length} 台主机</span></div>
              ${results.map(item => `<div class="row-item">
                <span class="badge badge-${item.code === 0 ? 'ok' : 'err'}">exit ${item.code}</span>
                <div class="row-content">
                  <div class="row-title"><strong>${esc(item.host)}</strong></div>
                  <pre style="margin-top:8px;font-size:11px">${esc((item.stdout || '').slice(0, 500))}</pre>
                  ${item.stderr ? `<pre style="color:var(--danger);font-size:11px">${esc((item.stderr || '').slice(0, 300))}</pre>` : ''}
                </div></div>`).join('')}
            </section>`;
        } catch (err) { $('batch-result').innerHTML = errorHTML(err); }
        btn.disabled = false; btn.textContent = '批量执行';
      };
    }

    function renderSnippets() {
      const c = $('ssh-content');
      c.innerHTML =
        `<div class="toolbar"><button id="add-snippet-btn" class="button primary">＋ 添加片段</button></div>` +
        `<section id="add-snippet-form" class="panel" hidden><div class="panel-head"><h3 id="snippet-form-title">添加命令片段</h3></div>
          <form id="snippet-form" class="panel-body form-grid">
            <input type="hidden" name="_edit" value="">
            <label>名称 *<input name="name" required placeholder="check-disk"></label>
            <label>命令 *<textarea name="command" required placeholder="df -h {{path}}" rows="3"></textarea></label>
            <label>描述<input name="description" placeholder="检查磁盘空间"></label>
            <div class="notice">支持变量: <code>{{host}}</code> <code>{{hostname}}</code> <code>{{user}}</code> <code>{{port}}</code> <code>{{date}}</code> <code>{{time}}</code> 或自定义 <code>{{name}}</code></div>
            <div class="actions"><button type="button" id="cancel-snippet" class="button">取消</button><button type="submit" class="button primary">保存</button></div>
          </form></section>` +
        `<section id="snippet-exec-panel" class="panel" hidden><div class="panel-head"><h3 id="snippet-exec-title">执行片段</h3><button class="button" id="cancel-exec">关闭</button></div>
          <div class="panel-body form-grid">
            <label>目标主机<select id="snippet-exec-host">${hostOptions()}</select></label>
            <div id="snippet-vars-inputs"></div>
            <div class="eyebrow">预览命令</div>
            <pre id="snippet-preview-cmd"></pre>
            <div class="actions"><button id="snippet-do-exec" class="button primary">执行</button></div>
          </div>
          <div id="snippet-exec-result"></div>
        </section>` +
        `<div id="snippet-list">${loading()}</div>`;

      $('add-snippet-btn').onclick = () => {
        const form = $('snippet-form');
        form.reset(); form._edit.value = '';
        $('snippet-form-title').textContent = '添加命令片段';
        form.name.disabled = false;
        $('add-snippet-form').hidden = !$('add-snippet-form').hidden;
        $('snippet-exec-panel').hidden = true;
      };
      $('cancel-snippet').onclick = () => { $('add-snippet-form').hidden = true; };
      $('cancel-exec').onclick = () => { $('snippet-exec-panel').hidden = true; };

      $('snippet-form').onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const isEdit = fd.get('_edit');
        try {
          if (isEdit) {
            await putJSON(API + '/ssh/snippets/' + encodeURIComponent(isEdit), {
              command: fd.get('command'), description: fd.get('description'),
            });
            toast('片段已更新');
          } else {
            await postJSON(API + '/ssh/snippets', { name: fd.get('name'), command: fd.get('command'), description: fd.get('description') });
            toast('片段已保存');
          }
          $('add-snippet-form').hidden = true;
          e.target.reset();
          loadSnippetList();
        } catch (err) { toast(err.message); }
      };

      loadSnippetList();
    }

    let _currentSnippet = null;

    function setupSnippetExec(snippet) {
      _currentSnippet = snippet;
      $('add-snippet-form').hidden = true;
      $('snippet-exec-panel').hidden = false;
      $('snippet-exec-title').textContent = '执行: ' + snippet.name;
      $('snippet-exec-result').innerHTML = '';

      const vars = (snippet.command.match(/\{\{(\w+)\}\}/g) || []).map(m => m.slice(2, -2));
      const builtins = ['host', 'hostname', 'user', 'port', 'date', 'time', 'timestamp', 'home'];
      const customVars = vars.filter(v => !builtins.includes(v));

      $('snippet-vars-inputs').innerHTML = customVars.length
        ? customVars.map(v => `<label>变量 {{${esc(v)}}}<input data-var="${esc(v)}" placeholder="输入值"></label>`).join('')
        : '';

      function updatePreview() {
        const h = sshHosts.find(x => x.name === $('snippet-exec-host').value);
        let cmd = snippet.command;
        if (h) {
          cmd = cmd.replace(/\{\{host\}\}/g, h.name).replace(/\{\{hostname\}\}/g, h.hostname)
            .replace(/\{\{user\}\}/g, h.user || '').replace(/\{\{port\}\}/g, String(h.port || 22));
        }
        cmd = cmd.replace(/\{\{date\}\}/g, new Date().toISOString().slice(0, 10))
          .replace(/\{\{time\}\}/g, new Date().toTimeString().slice(0, 8))
          .replace(/\{\{timestamp\}\}/g, String(Math.floor(Date.now() / 1000)))
          .replace(/\{\{home\}\}/g, '~');
        document.querySelectorAll('#snippet-vars-inputs [data-var]').forEach(inp => {
          if (inp.value) cmd = cmd.replace(new RegExp('\\{\\{' + inp.dataset.var + '\\}\\}', 'g'), inp.value);
        });
        $('snippet-preview-cmd').textContent = cmd;
      }

      $('snippet-exec-host').onchange = updatePreview;
      document.querySelectorAll('#snippet-vars-inputs input').forEach(inp => inp.oninput = updatePreview);
      updatePreview();

      $('snippet-do-exec').onclick = async () => {
        const host = $('snippet-exec-host').value;
        if (!host) { toast('请选择主机'); return; }
        const vars = {};
        document.querySelectorAll('#snippet-vars-inputs [data-var]').forEach(inp => {
          if (inp.value) vars[inp.dataset.var] = inp.value;
        });
        const btn = $('snippet-do-exec'); btn.disabled = true; btn.textContent = '执行中…';
        $('snippet-exec-result').innerHTML = loading();
        try {
          const r = await postJSON(API + '/ssh/snippets/' + encodeURIComponent(snippet.name) + '/exec', { host, vars });
          $('snippet-exec-result').innerHTML =
            `<div class="panel-body">
              <div class="eyebrow">实际执行命令</div><pre style="margin-bottom:12px;font-size:11px">${esc(r.command || '')}</pre>
              <span class="badge badge-${r.code === 0 ? 'ok' : 'err'}">exit ${r.code}</span>
              ${r.stdout ? `<div class="eyebrow" style="margin-top:8px">stdout</div><pre>${esc(r.stdout)}</pre>` : ''}
              ${r.stderr ? `<div class="eyebrow" style="margin-top:8px;color:var(--danger)">stderr</div><pre style="color:var(--danger)">${esc(r.stderr)}</pre>` : ''}
            </div>`;
        } catch (err) { $('snippet-exec-result').innerHTML = errorHTML(err); }
        btn.disabled = false; btn.textContent = '执行';
      };

      $('snippet-exec-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    async function loadSnippetList() {
      const el = $('snippet-list');
      if (!el) return;
      try {
        const list = await fetchJSON(API + '/ssh/snippets');
        if (!list.length) { el.innerHTML = empty('没有保存的片段。'); return; }
        el.innerHTML = list.map(s => `<div class="row-item">
          <span class="row-dot" style="border-color:var(--accent)"></span>
          <div class="row-content">
            <div class="row-title"><strong>${esc(s.name)}</strong>${s.description ? ` <span class="muted">— ${esc(s.description)}</span>` : ''}</div>
            <pre style="margin-top:6px;font-size:11px;color:var(--muted)">${esc(s.command)}</pre>
          </div>
          <div class="row-actions">
            <button class="button primary" data-exec-snippet="${esc(s.name)}">▶ 执行</button>
            <button class="button" data-edit-snippet="${esc(s.name)}">编辑</button>
            <button class="button" data-copy-snippet="${esc(s.command)}">复制</button>
            <button class="button danger" data-del-snippet="${esc(s.name)}">删除</button>
          </div>
        </div>`).join('');

        const snippetData = list;

        el.querySelectorAll('[data-exec-snippet]').forEach(b => b.onclick = () => {
          const s = snippetData.find(x => x.name === b.dataset.execSnippet);
          if (s) setupSnippetExec(s);
        });
        el.querySelectorAll('[data-edit-snippet]').forEach(b => b.onclick = () => {
          const s = snippetData.find(x => x.name === b.dataset.editSnippet);
          if (!s) return;
          $('add-snippet-form').hidden = false;
          $('snippet-exec-panel').hidden = true;
          $('snippet-form-title').textContent = '编辑片段: ' + s.name;
          const form = $('snippet-form');
          form._edit.value = s.name;
          form.name.value = s.name; form.name.disabled = true;
          form.command.value = s.command;
          form.description.value = s.description || '';
          $('add-snippet-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
        el.querySelectorAll('[data-copy-snippet]').forEach(b => b.onclick = async () => {
          try { await navigator.clipboard.writeText(b.dataset.copySnippet); toast('已复制'); } catch { toast('复制失败'); }
        });
        el.querySelectorAll('[data-del-snippet]').forEach(b => b.onclick = async () => {
          if (!confirm('删除片段 ' + b.dataset.delSnippet + '？')) return;
          try { await deleteJSON(API + '/ssh/snippets/' + encodeURIComponent(b.dataset.delSnippet)); toast('已删除'); loadSnippetList(); } catch (err) { toast(err.message); }
        });
      } catch { el.innerHTML = empty('无法加载片段'); }
    }

    async function renderKeys() {
      const c = $('ssh-content');
      c.innerHTML =
        `<div class="toolbar"><button id="gen-key-btn" class="button primary">＋ 生成密钥</button></div>` +
        `<section id="gen-key-form" class="panel" hidden><div class="panel-head"><h3>生成 SSH 密钥</h3></div>
          <form id="key-form" class="panel-body form-grid">
            <div class="form-inline">
              <label>类型<select name="type"><option value="ed25519" selected>Ed25519 (推荐)</option><option value="rsa">RSA</option><option value="ecdsa">ECDSA</option></select></label>
              <label>RSA 位数<input name="bits" type="number" value="4096" min="2048" max="8192" placeholder="仅 RSA"></label>
            </div>
            <label>备注<input name="comment" placeholder="user@machine"></label>
            <div class="actions"><button type="button" id="cancel-key" class="button">取消</button><button type="submit" class="button primary">生成</button></div>
          </form></section>` +
        `<div id="key-list">${loading()}</div>`;

      $('gen-key-btn').onclick = () => { $('gen-key-form').hidden = !$('gen-key-form').hidden; };
      $('cancel-key').onclick = () => { $('gen-key-form').hidden = true; };
      $('key-form').onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const body = { type: fd.get('type') };
        if (body.type === 'rsa' && fd.get('bits')) body.bits = Number(fd.get('bits'));
        if (fd.get('comment')) body.comment = fd.get('comment');
        try {
          const r = await postJSON(API + '/ssh/keys/generate', body);
          toast('密钥已生成: ' + (r.path || ''));
          $('gen-key-form').hidden = true;
          e.target.reset();
          loadKeyList();
        } catch (err) { toast(err.message); }
      };

      loadKeyList();
    }

    async function loadKeyList() {
      const el = $('key-list');
      if (!el) return;
      try {
        const keys = await fetchJSON(API + '/ssh/keys');
        if (!keys.length) { el.innerHTML = empty('未找到 SSH 密钥 (~/.ssh/id_*)'); return; }
        el.innerHTML = keys.map(k => `<div class="row-item">
          <span class="row-dot" style="border-color:${k.hasPublic ? 'var(--success)' : 'var(--warning)'}"></span>
          <div class="row-content">
            <div class="row-title"><strong>${esc(k.name)}</strong> <span class="badge badge-${k.type ? 'ok' : 'off'}">${esc(k.type || '未知')}</span>${k.comment ? ` <span class="muted">— ${esc(k.comment)}</span>` : ''}</div>
            <div class="row-meta">
              <span style="font-family:monospace;font-size:10px">${esc(k.fingerprint || '—')}</span>
              ${k.hasPublic ? '<span class="badge badge-ok">有公钥</span>' : '<span class="badge badge-warn">无公钥</span>'}
            </div>
          </div>
          <button class="button danger" data-del-key="${esc(k.name)}">删除</button>
        </div>`).join('');

        el.querySelectorAll('[data-del-key]').forEach(b => b.onclick = async () => {
          if (!confirm('确认删除密钥 ' + b.dataset.delKey + '？（私钥和公钥都会被删除，不可恢复）')) return;
          try {
            await deleteJSON(API + '/ssh/keys/' + encodeURIComponent(b.dataset.delKey));
            toast('密钥已删除');
            loadKeyList();
          } catch (err) { toast(err.message); }
        });
      } catch (err) { el.innerHTML = errorHTML(err); }
    }

    function renderTunnels() {
      const c = $('ssh-content');
      c.innerHTML =
        `<div class="toolbar"><button id="add-tunnel-btn" class="button primary">＋ 创建隧道</button><button id="refresh-tunnels" class="button">刷新</button></div>` +
        `<section id="add-tunnel-form" class="panel" hidden><div class="panel-head"><h3>创建 SSH 隧道</h3></div>
          <form id="tunnel-form" class="panel-body form-grid">
            <div class="form-inline">
              <label>主机 *<select name="host">${hostOptions()}</select></label>
              <label>类型<select name="type" id="tunnel-type-select">
                <option value="local">本地转发 (-L)</option>
                <option value="remote">远程转发 (-R)</option>
                <option value="dynamic">动态代理 (-D SOCKS5)</option>
              </select></label>
            </div>
            <div id="tunnel-type-hint" class="notice"></div>
            <div class="form-inline">
              <label id="tunnel-local-label">本地端口 *<input name="localPort" type="number" required min="1" max="65535" placeholder="8080"></label>
              <label id="tunnel-remote-host-label">远程主机<input name="remoteHost" value="127.0.0.1" placeholder="127.0.0.1"></label>
            </div>
            <label id="tunnel-remote-port-label">远程端口<input name="remotePort" type="number" min="1" max="65535" placeholder="80"></label>
            <div class="actions"><button type="button" id="cancel-tunnel" class="button">取消</button><button type="submit" class="button primary">创建</button></div>
          </form></section>` +
        `<div id="tunnel-list">${loading()}</div>`;

      const tunnelHints = {
        local: {
          title: '本地转发 (ssh -L)',
          desc: '将本机端口的流量，通过 SSH 主机，转发到远程目标。',
          use: '访问远程服务器上只监听 127.0.0.1 的服务（数据库、内部 API 等）',
          example: '本地 8080 → SSH主机 → 远端 127.0.0.1:3306',
          tip: '创建后访问 localhost:本地端口 即可连接远程服务',
        },
        remote: {
          title: '远程转发 (ssh -R)',
          desc: '将 SSH 主机上的端口，反向转发到本机。',
          use: '让远程服务器能访问你本地运行的服务（调试回调、webhook 等）',
          example: '远端 :9090 → SSH隧道 → 本机 localhost:3000',
          tip: '在远程服务器上访问 localhost:远程端口 即可连到你本机',
        },
        dynamic: {
          title: '动态代理 (ssh -D SOCKS5)',
          desc: '在本机开一个 SOCKS5 代理，所有流量通过 SSH 主机出去。',
          use: '科学上网、访问远程内网所有服务（无需逐个转发端口）',
          example: '浏览器/curl → localhost:本地端口 (SOCKS5) → SSH主机 → 目标',
          tip: '浏览器设置 SOCKS5 代理为 127.0.0.1:本地端口，远程主机和端口不需要填',
        },
      };

      function updateTunnelHint() {
        const type = $('tunnel-type-select').value;
        const h = tunnelHints[type];
        $('tunnel-type-hint').innerHTML =
          '<strong>' + esc(h.title) + '</strong><br>' +
          esc(h.desc) + '<br><br>' +
          '<span style="color:var(--ink-secondary)">📌 场景：</span>' + esc(h.use) + '<br>' +
          '<span style="color:var(--ink-secondary)">🔗 流向：</span><code style="font-size:11px">' + esc(h.example) + '</code><br>' +
          '<span style="color:var(--ink-secondary)">💡 提示：</span>' + esc(h.tip);
        const isDynamic = type === 'dynamic';
        $('tunnel-remote-host-label').style.display = isDynamic ? 'none' : '';
        $('tunnel-remote-port-label').style.display = isDynamic ? 'none' : '';
      }

      $('add-tunnel-btn').onclick = () => { $('add-tunnel-form').hidden = !$('add-tunnel-form').hidden; if (!$('add-tunnel-form').hidden) updateTunnelHint(); };
      $('cancel-tunnel').onclick = () => { $('add-tunnel-form').hidden = true; };
      $('refresh-tunnels').onclick = loadTunnelList;
      $('tunnel-type-select').onchange = updateTunnelHint;

      $('tunnel-form').onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const body = {
          host: fd.get('host'), type: fd.get('type'),
          localPort: Number(fd.get('localPort')),
          remoteHost: fd.get('remoteHost') || '127.0.0.1',
          remotePort: Number(fd.get('remotePort')) || 0,
        };
        try {
          await postJSON(API + '/ssh/tunnels', body);
          toast('隧道已创建');
          $('add-tunnel-form').hidden = true;
          e.target.reset();
          loadTunnelList();
        } catch (err) { toast(err.message); }
      };

      loadTunnelList();
    }

    async function loadTunnelList() {
      const el = $('tunnel-list');
      if (!el) return;
      try {
        const tunnels = await fetchJSON(API + '/ssh/tunnels');
        if (!tunnels.length) { el.innerHTML = empty('没有活跃的隧道。创建一个新的隧道来转发端口。'); return; }
        const typeLabel = { local: '本地转发', remote: '远程转发', dynamic: 'SOCKS5' };
        el.innerHTML = tunnels.map(t => `<div class="row-item">
          <span class="row-dot" style="background:${t.alive ? 'var(--success)' : 'var(--danger)'};border-color:transparent"></span>
          <div class="row-content">
            <div class="row-title">
              <strong>${esc(t.host)}</strong>
              <span class="badge badge-${t.alive ? 'ok' : 'err'}">${t.alive ? '活跃' : '已断开'}</span>
              <span class="badge badge-off">${esc(typeLabel[t.type] || t.type)}</span>
            </div>
            <div class="row-meta">
              ${t.type === 'dynamic'
                ? `<span>SOCKS5 → localhost:${t.localPort}</span>`
                : `<span>localhost:${t.localPort} ↔ ${esc(t.remoteHost)}:${t.remotePort}</span>`}
              <span class="muted">PID ${t.pid}</span>
              <span class="muted">${esc(t.startedAt?.slice(0, 19).replace('T', ' ') || '')}</span>
              ${t.error ? `<span class="badge badge-err">${esc(t.error)}</span>` : ''}
            </div>
          </div>
          <button class="button danger" data-close-tunnel="${esc(t.id)}">关闭</button>
        </div>`).join('');

        el.querySelectorAll('[data-close-tunnel]').forEach(b => b.onclick = async () => {
          if (!confirm('关闭此隧道？')) return;
          try {
            await deleteJSON(API + '/ssh/tunnels/' + encodeURIComponent(b.dataset.closeTunnel));
            toast('隧道已关闭');
            loadTunnelList();
          } catch (err) { toast(err.message); }
        });
      } catch (err) { el.innerHTML = errorHTML(err); }
    }

    // ── Files tab (integrated) ──
    function renderFiles() {
      const c = $('ssh-content');
      if (!filesHost && sshHosts.length) filesHost = sshHosts[0].name;
      c.innerHTML =
        `<section class="panel"><div class="panel-body form-grid">
          <div class="form-inline">
            <label>主机<select id="file-host">${sshHosts.map(h => `<option value="${esc(h.name)}" ${h.name === filesHost ? 'selected' : ''}>${esc(h.name)} (${esc(h.hostname)})</option>`).join('')}</select></label>
            <label>路径<input id="file-path" value="${esc(filesPath)}"></label>
          </div>
          <div class="toolbar" style="margin-top:0">
            <button id="file-go" class="button primary">浏览</button>
            <button id="file-up" class="button">上级目录</button>
            <button id="file-mkdir" class="button">📁 新建目录</button>
            <label class="toggle-row"><input type="checkbox" id="file-hidden" ${filesShowHidden ? 'checked' : ''}> 显示隐藏文件</label>
          </div>
        </div></section>
        <div id="file-content"></div>`;

      $('file-host').onchange = (e) => { filesHost = e.target.value; };
      $('file-path').onchange = (e) => { filesPath = e.target.value; };
      $('file-hidden').onchange = (e) => { filesShowHidden = e.target.checked; };
      $('file-go').onclick = () => { filesHost = $('file-host').value; filesPath = $('file-path').value; loadFilesDir(); };
      $('file-up').onclick = () => {
        const parts = filesPath.replace(/\/+$/, '').split('/');
        parts.pop();
        filesPath = parts.join('/') || '/';
        $('file-path').value = filesPath;
        loadFilesDir();
      };
      $('file-mkdir').onclick = async () => {
        const name = prompt('新目录名称:');
        if (!name) return;
        const dirPath = filesPath.replace(/\/+$/, '') + '/' + name;
        try {
          await postJSON(API + '/ssh/file/mkdir', { host: filesHost, path: dirPath });
          toast('目录已创建');
          loadFilesDir();
        } catch (err) { toast(err.message); }
      };

      if (filesHost) loadFilesDir();
    }

    async function loadFilesDir() {
      const el = $('file-content');
      if (!el) return;
      el.innerHTML = loading();
      try {
        const r = await postJSON(API + '/ssh/file/list', { host: filesHost, path: filesPath, all: filesShowHidden });
        if (token !== generation) return;
        const items = r.items || r.files || [];
        if (!items.length) { el.innerHTML = empty('空目录'); return; }
        el.innerHTML = `<section class="panel"><div class="panel-head"><h3>${esc(filesPath)}</h3><span class="badge badge-off">${items.length} 项</span></div>
          <table class="file-table"><thead><tr><th>名称</th><th>大小</th><th>权限</th><th>修改时间</th><th></th></tr></thead><tbody>
            ${items.map(f => {
              const isDir = f.isDir || f.type === 'd' || f.type === 'directory' || (f.name || '').endsWith('/');
              return `<tr><td><button class="file-link" data-file-name="${esc(f.name)}" data-file-type="${isDir ? 'dir' : 'file'}">${isDir ? '📁' : '📄'} ${esc(f.name)}</button></td>
                <td class="muted">${esc(f.size || '—')}</td><td class="muted" style="font-family:monospace;font-size:11px">${esc(f.perm || f.permissions || f.mode || '—')}</td>
                <td class="muted">${esc(f.modified || f.mtime || '—')}</td>
                <td><button class="button danger" style="padding:3px 8px;font-size:10px" data-del-file="${esc(f.name)}" data-del-is-dir="${isDir}">删除</button></td></tr>`;
            }).join('')}
          </tbody></table></section>`;

        el.querySelectorAll('[data-file-name]').forEach(b => b.onclick = () => {
          if (b.dataset.fileType === 'dir') {
            filesPath = filesPath.replace(/\/+$/, '') + '/' + b.dataset.fileName.replace(/\/+$/, '');
            $('file-path').value = filesPath;
            loadFilesDir();
          } else {
            loadFilesFile(b.dataset.fileName);
          }
        });

        el.querySelectorAll('[data-del-file]').forEach(b => b.onclick = async () => {
          const name = b.dataset.delFile;
          const isDir = b.dataset.delIsDir === 'true';
          if (!confirm(`确认删除${isDir ? '目录' : '文件'} ${name}？${isDir ? '（递归删除所有内容）' : ''}`)) return;
          const fullPath = filesPath.replace(/\/+$/, '') + '/' + name;
          try {
            await postJSON(API + '/ssh/file/delete', { host: filesHost, path: fullPath, recursive: isDir });
            toast('已删除');
            loadFilesDir();
          } catch (err) { toast(err.message); }
        });
      } catch (err) { el.innerHTML = errorHTML(err); }
    }

    async function loadFilesFile(name) {
      const el = $('file-content');
      el.innerHTML = loading();
      const fullPath = filesPath.replace(/\/+$/, '') + '/' + name;
      try {
        const r = await postJSON(API + '/ssh/file/read', { host: filesHost, path: fullPath });
        const content = r.content || r.text || '';
        el.innerHTML = `<section class="panel"><div class="panel-head"><h3>${esc(fullPath)}</h3>
            <div class="row-actions">
              <button class="button" id="file-edit-toggle">编辑</button>
              <button class="button" id="file-back">返回目录</button>
            </div>
          </div>
          <div class="panel-body">
            <pre id="file-view-pre">${esc(content || '(空文件)')}</pre>
            <div id="file-edit-area" hidden>
              <textarea id="file-edit-content" style="width:100%;min-height:300px;font-family:monospace;font-size:12px">${esc(content)}</textarea>
              <div class="actions"><button id="file-save" class="button primary">保存</button><button id="file-cancel-edit" class="button">取消</button></div>
            </div>
          </div></section>`;
        $('file-back').onclick = () => loadFilesDir();
        $('file-edit-toggle').onclick = () => {
          $('file-view-pre').hidden = true;
          $('file-edit-area').hidden = false;
          $('file-edit-toggle').hidden = true;
        };
        $('file-cancel-edit').onclick = () => {
          $('file-view-pre').hidden = false;
          $('file-edit-area').hidden = true;
          $('file-edit-toggle').hidden = false;
        };
        $('file-save').onclick = async () => {
          const btn = $('file-save'); btn.disabled = true; btn.textContent = '保存中…';
          try {
            await postJSON(API + '/ssh/file/write', { host: filesHost, path: fullPath, content: $('file-edit-content').value });
            toast('文件已保存');
            loadFilesFile(name);
          } catch (err) { toast(err.message); }
          btn.disabled = false; btn.textContent = '保存';
        };
      } catch (err) { el.innerHTML = errorHTML(err) + `<div class="actions"><button class="button" id="file-back">返回目录</button></div>`; $('file-back').onclick = () => loadFilesDir(); }
    }

    // ── Stats / Monitoring tab ──
    let statsInterval = 0, statsTimer = null;

    function clearStatsTimer() { if (statsTimer) { clearInterval(statsTimer); statsTimer = null; } }

    function renderStats() {
      const c = $('ssh-content');
      if (!statsHost && sshHosts.length) statsHost = sshHosts[0].name;
      c.innerHTML =
        `<section class="panel"><div class="panel-body form-grid">
          <div class="form-inline">
            <label>主机<select id="stats-host">${sshHosts.map(h => `<option value="${esc(h.name)}" ${h.name === statsHost ? 'selected' : ''}>${esc(h.name)} (${esc(h.hostname)})</option>`).join('')}</select></label>
            <label>自动刷新<select id="stats-freq">
              <option value="0" ${statsInterval === 0 ? 'selected' : ''}>关闭</option>
              <option value="5" ${statsInterval === 5 ? 'selected' : ''}>5 秒</option>
              <option value="10" ${statsInterval === 10 ? 'selected' : ''}>10 秒</option>
              <option value="15" ${statsInterval === 15 ? 'selected' : ''}>15 秒</option>
            </select></label>
          </div>
          <div class="toolbar" style="margin-top:0"><button id="stats-refresh" class="button primary">刷新</button></div>
        </div></section>
        <div id="stats-content"></div>`;
      $('stats-host').onchange = (e) => { statsHost = e.target.value; };
      $('stats-freq').onchange = (e) => {
        statsInterval = Number(e.target.value);
        clearStatsTimer();
        if (statsInterval > 0) statsTimer = setInterval(() => { if (sshTab === 'stats') loadStats(); else clearStatsTimer(); }, statsInterval * 1000);
      };
      $('stats-refresh').onclick = () => { statsHost = $('stats-host').value; loadStats(); };
      clearStatsTimer();
      if (statsInterval > 0) statsTimer = setInterval(() => { if (sshTab === 'stats') loadStats(); else clearStatsTimer(); }, statsInterval * 1000);
      if (statsHost) loadStats();
    }

    function meterColor(pct) { return pct >= 80 ? 'red' : pct >= 50 ? 'yellow' : 'green'; }

    function meterBar(pct, label) {
      const color = meterColor(pct);
      return `<div class="meter"><div class="meter-fill ${color}" style="width:${Math.min(pct, 100)}%"></div><span class="meter-label">${label || (pct.toFixed(1) + '%')}</span></div>`;
    }

    async function loadStats() {
      const el = $('stats-content');
      if (!el) return;
      el.innerHTML = loading() + '<p class="muted" style="text-align:center;margin-top:8px">采集中，约需 2 秒…</p>';
      try {
        const r = await postJSON(API + '/ssh/hosts/' + encodeURIComponent(statsHost) + '/stats', {});
        if (token !== generation) return;
        if (!r.ok) { el.innerHTML = errorHTML(new Error(r.error || '采集失败')); return; }

        const usedMem = r.memory.total - r.memory.available;
        const memPct = r.memory.total > 0 ? (usedMem / r.memory.total * 100) : 0;
        const swapUsed = r.memory.swapTotal - r.memory.swapFree;
        const swapPct = r.memory.swapTotal > 0 ? (swapUsed / r.memory.swapTotal * 100) : 0;

        el.innerHTML = `<div class="stats-grid">
          <section class="panel"><div class="panel-head"><h3>CPU</h3><span class="badge">${r.cpu.overall.toFixed(1)}%</span>
            <span class="muted" style="font-size:11px;margin-left:8px">Load: ${r.load['1m']} / ${r.load['5m']} / ${r.load['15m']}</span>
          </div><div class="panel-body">
            <div class="cpu-core-row"><span class="label">总计</span>${meterBar(r.cpu.overall)}<span class="pct">${r.cpu.overall.toFixed(1)}%</span></div>
            ${r.cpu.cores.map(c => `<div class="cpu-core-row"><span class="label">核心 ${c.id}</span>${meterBar(c.usage)}<span class="pct">${c.usage.toFixed(1)}%</span></div>`).join('')}
          </div></section>

          <section class="panel"><div class="panel-head"><h3>内存</h3><span class="badge">${memPct.toFixed(1)}%</span></div><div class="panel-body">
            <div class="cpu-core-row"><span class="label">RAM</span>${meterBar(memPct, usedMem + ' / ' + r.memory.total + ' MB')}<span class="pct">${memPct.toFixed(1)}%</span></div>
            ${r.memory.swapTotal > 0 ? `<div class="cpu-core-row"><span class="label">Swap</span>${meterBar(swapPct, swapUsed + ' / ' + r.memory.swapTotal + ' MB')}<span class="pct">${swapPct.toFixed(1)}%</span></div>` : ''}
            <div class="muted" style="font-size:11px;margin-top:4px">Buffers: ${r.memory.buffers} MB　Cached: ${r.memory.cached} MB</div>
          </div></section>

          <section class="panel"><div class="panel-head"><h3>磁盘</h3></div><div class="panel-body">
            ${r.disk.map(d => {
              const pct = d.size > 0 ? (d.used / d.size * 100) : 0;
              const sizeGB = (d.size / 1048576).toFixed(1);
              const usedGB = (d.used / 1048576).toFixed(1);
              return `<div class="cpu-core-row"><span class="label" title="${esc(d.fs)}">${esc(d.mount)}</span>${meterBar(pct, usedGB + ' / ' + sizeGB + ' GB')}<span class="pct">${pct.toFixed(1)}%</span></div>`;
            }).join('')}
          </div></section>

          <section class="panel"><div class="panel-head"><h3>进程</h3><span class="badge">${r.processes.total} 进程</span><span class="badge badge-off" style="margin-left:4px">${r.processes.threads} 线程</span></div><div class="panel-body">
            <table class="file-table"><thead><tr><th>PID</th><th>用户</th><th>CPU%</th><th>内存%</th><th>线程</th><th>命令</th></tr></thead><tbody>
              ${r.top.map(p => `<tr><td class="muted">${p.pid}</td><td>${esc(p.user)}</td>
                <td><span style="color:${p.cpu >= 50 ? 'var(--danger)' : p.cpu >= 20 ? '#eab308' : 'inherit'};font-weight:${p.cpu >= 20 ? '600' : 'normal'}">${p.cpu.toFixed(1)}</span></td>
                <td>${p.mem.toFixed(1)}</td><td>${p.threads}</td><td style="font-family:monospace;font-size:11px">${esc(p.command)}</td></tr>`).join('')}
            </tbody></table>
          </div></section>
        </div>`;
      } catch (err) { el.innerHTML = errorHTML(err); }
    }

    await loadHosts();
    renderPage();
  }

  // ============================================================
  // K8S PAGE
  // ============================================================
  async function k8sPage(token) {
    let k8sTab = 'contexts';
    let contexts = [];
    let selectedCtx = '';
    let selectedNs = 'default';

    async function loadContexts() {
      try { contexts = await fetchJSON(API + '/k8s/contexts'); } catch { contexts = []; }
    }

    function contextOptions() {
      return contexts.map(c => `<option value="${esc(c.name)}" ${c.name === selectedCtx ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    }

    async function loadNsOptions(selId, ctxId, opts) {
      const sel = $(selId);
      const ctx = $(ctxId).value;
      sel.innerHTML = '<option value="">加载中…</option>';
      try {
        const r = await postJSON(API + '/k8s/resources', { context: ctx, kind: 'namespaces' });
        const nsList = (r.items || []).map(i => i.metadata?.name).filter(Boolean).sort();
        const allLabel = (opts && opts.allLabel) || '所有命名空间';
        sel.innerHTML = `<option value="">${allLabel}</option>` + nsList.map(n => `<option value="${esc(n)}"${n === selectedNs ? ' selected' : ''}>${esc(n)}</option>`).join('');
      } catch { sel.innerHTML = '<option value="">加载失败</option>'; }
    }

    function formatAge(ts) {
      if (!ts) return '-';
      const ms = Date.now() - new Date(ts).getTime();
      if (ms < 0) return '0s';
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm';
      const h = Math.floor(m / 60);
      if (h < 24) return h + 'h' + (m % 60 ? (m % 60) + 'm' : '');
      const d = Math.floor(h / 24);
      return d + 'd' + (h % 24 ? (h % 24) + 'h' : '');
    }

    function podReady(pod) {
      const cs = pod.status?.containerStatuses || [];
      const total = cs.length || (pod.spec?.containers?.length || 1);
      const ready = cs.filter(c => c.ready).length;
      return ready + '/' + total;
    }

    function podRestarts(pod) {
      return (pod.status?.containerStatuses || []).reduce((s, c) => s + (c.restartCount || 0), 0);
    }

    function podPhase(pod) {
      const cs = pod.status?.containerStatuses || [];
      const waiting = cs.find(c => c.state?.waiting?.reason);
      if (waiting) return waiting.state.waiting.reason;
      return pod.status?.phase || 'Unknown';
    }

    function statusDotClass(phase) {
      const p = (phase || '').toLowerCase();
      if (p === 'running' || p === 'active' || p === 'bound') return 'running';
      if (p === 'pending' || p === 'containercreating') return 'pending';
      if (p === 'succeeded' || p === 'completed') return 'succeeded';
      if (p === 'failed' || p === 'error' || p === 'crashloopbackoff' || p === 'imagepullbackoff' || p === 'errimagepull') return 'failed';
      return 'unknown';
    }

    function extractPorts(svc) {
      return (svc.spec?.ports || []).map(p => `${p.port}${p.nodePort ? ':' + p.nodePort : ''}/${p.protocol || 'TCP'}`).join(', ');
    }

    function nodeRoles(node) {
      const labels = node.metadata?.labels || {};
      const roles = Object.keys(labels).filter(k => k.startsWith('node-role.kubernetes.io/')).map(k => k.split('/')[1]);
      return roles.length ? roles.join(', ') : '<none>';
    }

    function nodeReady(node) {
      const c = (node.status?.conditions || []).find(c => c.type === 'Ready');
      return c?.status === 'True';
    }

    function renderK8s() {
      if (token !== generation) return;
      $('main').innerHTML = title('Kubernetes', 'K8S CLUSTER MANAGEMENT', '集群管理、资源浏览与诊断') +
        tabs([['contexts', '集群'], ['overview', '概览'], ['resources', '资源'], ['helm', 'Helm'], ['logs', '日志'], ['exec', '执行'], ['events', '事件']], k8sTab, 'data-k8s-tab') +
        '<div id="k8s-content"></div>';

      document.querySelectorAll('[data-k8s-tab]').forEach(b => b.onclick = () => { k8sTab = b.dataset.k8sTab; renderK8s(); });

      if (k8sTab === 'contexts') renderContexts();
      else if (k8sTab === 'overview') renderOverview();
      else if (k8sTab === 'resources') renderResources();
      else if (k8sTab === 'helm') renderHelm();
      else if (k8sTab === 'logs') renderLogs();
      else if (k8sTab === 'exec') renderExec();
      else if (k8sTab === 'events') renderEvents();
    }

    // ── Contexts Tab ──
    function renderContexts() {
      const c = $('k8s-content');
      c.innerHTML =
        `<div class="toolbar"><button id="add-ctx-btn" class="button primary">＋ 添加集群</button></div>` +
        `<section id="add-ctx-form" class="panel" hidden><div class="panel-head"><h3>添加集群上下文</h3></div>
          <div class="panel-body">
            <div class="add-mode-chips">
              <button class="chip active" data-add-mode="kubeconfig">从 Kubeconfig 导入</button>
              <button class="chip" data-add-mode="paste">粘贴 Kubeconfig</button>
              <button class="chip" data-add-mode="token">Token 认证</button>
              <button class="chip" data-add-mode="cert">证书认证</button>
            </div>
            <div id="add-ctx-body"></div>
          </div></section>` +
        `<div id="ctx-list">${loading()}</div>`;

      let addMode = 'kubeconfig';
      $('add-ctx-btn').onclick = () => { const f = $('add-ctx-form'); f.hidden = !f.hidden; if (!f.hidden) renderAddMode(); };

      document.querySelectorAll('[data-add-mode]').forEach(b => b.onclick = () => {
        addMode = b.dataset.addMode;
        document.querySelectorAll('[data-add-mode]').forEach(x => x.classList.toggle('active', x === b));
        renderAddMode();
      });

      function renderAddMode() {
        const el = $('add-ctx-body');
        if (!el) return;
        if (addMode === 'kubeconfig') {
          el.innerHTML = `<div class="form-grid">
            <label>Kubeconfig 文件路径
              <div style="display:flex;gap:8px">
                <input id="kc-path-input" value="~/.kube/config" placeholder="~/.kube/config" style="flex:1">
                <button type="button" id="kc-browse-btn" class="button">浏览…</button>
              </div>
            </label>
            <div class="actions"><button type="button" id="kc-parse-btn" class="button primary">解析</button></div>
          </div>
          <div id="kc-browser" hidden style="margin-top:12px;border:1px solid var(--line);border-radius:var(--radius);max-height:300px;overflow-y:auto"></div>
          <div id="kc-parse-result"></div>`;

          $('kc-browse-btn').onclick = () => { const br = $('kc-browser'); br.hidden = !br.hidden; if (!br.hidden) browseDir('~/.kube'); };
          $('kc-parse-btn').onclick = async () => {
            const path = $('kc-path-input').value;
            $('kc-parse-result').innerHTML = loading();
            try {
              const r = await postJSON(API + '/k8s/parse-kubeconfig', { path });
              renderImportList(r, path, null);
            } catch (err) { $('kc-parse-result').innerHTML = errorHTML(err); }
          };

          async function browseDir(dir) {
            const br = $('kc-browser');
            if (!br) return;
            br.innerHTML = '<div class="loading" style="padding:12px">加载中…</div>';
            try {
              const r = await postJSON(API + '/k8s/browse-local', { path: dir, showHidden: false });
              if (r.isFile) { $('kc-path-input').value = r.path; br.hidden = true; return; }
              let html = `<div style="padding:8px 12px;font-size:11px;color:var(--muted);border-bottom:1px solid var(--line-soft);display:flex;justify-content:space-between;align-items:center">
                <span style="font-family:monospace">${esc(r.dir)}</span>
                <button class="button" data-browse-up="${esc(r.parent)}" style="padding:2px 8px;font-size:10px">↑ 上级</button>
              </div>`;
              html += r.entries.map(e => `<div style="padding:6px 12px;font-size:12px;border-bottom:1px solid var(--line-soft);cursor:pointer;display:flex;align-items:center;gap:8px" class="file-browse-item" data-browse-pick="${esc(e.path)}" data-is-dir="${e.isDir}">
                <span style="opacity:.6">${e.isDir ? '📁' : '📄'}</span>
                <span>${esc(e.name)}</span>
              </div>`).join('');
              br.innerHTML = html;
              br.querySelectorAll('[data-browse-up]').forEach(b => b.onclick = () => browseDir(b.dataset.browseUp));
              br.querySelectorAll('[data-browse-pick]').forEach(b => b.onclick = () => {
                if (b.dataset.isDir === 'true') { browseDir(b.dataset.browsePick); }
                else { $('kc-path-input').value = b.dataset.browsePick; br.hidden = true; }
              });
            } catch (err) { br.innerHTML = `<div style="padding:12px;color:var(--danger);font-size:12px">${esc(err.message)}</div>`; }
          }
        } else if (addMode === 'paste') {
          el.innerHTML = `<form id="kc-paste-form" class="form-grid">
            <label>粘贴完整 Kubeconfig YAML<textarea name="content" rows="6" placeholder="apiVersion: v1\nkind: Config\n..."></textarea></label>
            <div class="actions"><button type="submit" class="button primary">解析</button></div>
          </form><div id="kc-parse-result"></div>`;
          $('kc-paste-form').onsubmit = async (e) => {
            e.preventDefault();
            const content = new FormData(e.target).get('content');
            $('kc-parse-result').innerHTML = loading();
            try {
              const r = await postJSON(API + '/k8s/parse-kubeconfig', { content });
              renderImportList(r, null, content);
            } catch (err) { $('kc-parse-result').innerHTML = errorHTML(err); }
          };
        } else if (addMode === 'token') {
          el.innerHTML = `<div class="notice" style="margin-bottom:16px">
            <strong>Token 认证</strong>适用于以下场景：<br>
            · 云厂商（阿里云 ACK、腾讯 TKE、AWS EKS 等）提供的集群连接 Token<br>
            · Kubernetes Dashboard 或 ServiceAccount 的 Token（<code>kubectl create token &lt;sa&gt;</code>）<br>
            · OIDC / SSO 认证后获取的 Bearer Token<br>
            <span class="muted">如果你有 kubeconfig 文件，建议使用"从 Kubeconfig 导入"方式，更简单。</span>
          </div>
          <form id="token-form" class="form-grid">
            <div class="form-inline">
              <label>名称 *<input name="name" required placeholder="my-cluster"></label>
              <label>默认命名空间<input name="namespace" value="default"></label>
            </div>
            <label>API Server URL *<input name="server" required placeholder="https://api-server:6443"></label>
            <label>Bearer Token *<textarea name="token" rows="3" required placeholder="eyJhbG..."></textarea></label>
            <label>CA 证书（可选，不填则跳过 TLS 验证）<textarea name="caData" rows="3" placeholder="-----BEGIN CERTIFICATE-----"></textarea></label>
            <div class="actions"><button type="button" id="cancel-token" class="button">取消</button><button type="submit" class="button primary">保存</button></div>
          </form>`;
          $('cancel-token').onclick = () => { $('add-ctx-form').hidden = true; };
          $('token-form').onsubmit = async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            try {
              await postJSON(API + '/k8s/contexts', { name: fd.get('name'), server: fd.get('server'), token: fd.get('token'), caData: fd.get('caData') || undefined, namespace: fd.get('namespace') || 'default', source: 'token' });
              toast('集群已添加'); $('add-ctx-form').hidden = true; await loadContexts(); renderContextList();
            } catch (err) { toast(err.message); }
          };
        } else if (addMode === 'cert') {
          el.innerHTML = `<div class="notice" style="margin-bottom:16px">
            <strong>证书认证</strong>（mTLS）适用于以下场景：<br>
            · 自建集群的管理员证书（如 kubeadm 生成的 admin.conf 中的证书）<br>
            · 通过 Kubernetes CSR 签发的用户证书<br>
            · 运维团队直接分发的客户端证书文件（.pem / .crt / .key）<br>
            <span class="muted">需要三个部分：CA 证书（验证服务端）、客户端证书 + 密钥（证明你的身份）。</span>
          </div>
          <form id="cert-form" class="form-grid">
            <div class="form-inline">
              <label>名称 *<input name="name" required placeholder="my-cluster"></label>
              <label>默认命名空间<input name="namespace" value="default"></label>
            </div>
            <label>API Server URL *<input name="server" required placeholder="https://api-server:6443"></label>
            <label>CA 证书（验证服务端身份）<textarea name="caData" rows="3" placeholder="-----BEGIN CERTIFICATE-----&#10;粘贴 CA 证书内容，通常从管理员获取"></textarea></label>
            <label>客户端证书 *（你的身份证书）<textarea name="certData" rows="3" required placeholder="-----BEGIN CERTIFICATE-----&#10;粘贴客户端证书内容"></textarea></label>
            <label>客户端密钥 *（你的私钥）<textarea name="keyData" rows="3" required placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;粘贴客户端私钥内容"></textarea></label>
            <div class="actions"><button type="button" id="cancel-cert" class="button">取消</button><button type="submit" class="button primary">保存</button></div>
          </form>`;
          $('cancel-cert').onclick = () => { $('add-ctx-form').hidden = true; };
          $('cert-form').onsubmit = async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            try {
              await postJSON(API + '/k8s/contexts', { name: fd.get('name'), server: fd.get('server'), caData: fd.get('caData') || undefined, certData: fd.get('certData'), keyData: fd.get('keyData'), namespace: fd.get('namespace') || 'default', source: 'cert' });
              toast('集群已添加'); $('add-ctx-form').hidden = true; await loadContexts(); renderContextList();
            } catch (err) { toast(err.message); }
          };
        }
      }

      function renderImportList(parsed, path, content) {
        const el = $('kc-parse-result');
        if (!el) return;
        if (!parsed.contexts?.length) { el.innerHTML = empty('未发现任何上下文'); return; }
        const existing = new Set(contexts.map(c => c.name));
        el.innerHTML = `<div class="ctx-import-list" style="margin-top:12px;border:1px solid var(--line);border-radius:var(--radius)">
          ${parsed.contexts.map(c => {
            const cluster = parsed.clusters?.find(cl => cl.name === c.cluster);
            const exists = existing.has(c.name);
            return `<label${exists ? ' style="opacity:.5"' : ''}>
              <input type="checkbox" value="${esc(c.name)}" ${exists ? 'disabled' : 'checked'}>
              <div>
                <strong>${esc(c.name)}</strong>${parsed.currentContext === c.name ? ' <span class="badge badge-ok">current</span>' : ''}${exists ? ' <span class="badge badge-off">已存在</span>' : ''}
                <div class="muted" style="font-size:11px">${esc(cluster?.server || '')} · ns: ${esc(c.namespace || 'default')}</div>
              </div>
            </label>`;
          }).join('')}
        </div>
        <div class="actions" style="margin-top:12px">
          <button type="button" id="cancel-import" class="button">取消</button>
          <button type="button" id="do-import" class="button primary">导入选中</button>
        </div>`;

        $('cancel-import').onclick = () => { $('add-ctx-form').hidden = true; };
        $('do-import').onclick = async () => {
          const checks = el.querySelectorAll('input[type=checkbox]:checked');
          const selected = Array.from(checks).map(c => c.value);
          if (!selected.length) { toast('请选择至少一个上下文'); return; }
          try {
            const body = { selected };
            if (path) body.path = path;
            if (content) body.content = content;
            await postJSON(API + '/k8s/import-contexts', body);
            toast(`已导入 ${selected.length} 个上下文`);
            $('add-ctx-form').hidden = true;
            await loadContexts(); renderContextList();
          } catch (err) { toast(err.message); }
        };
      }

      renderAddMode();
      loadContexts().then(renderContextList);
    }

    function renderContextList() {
      const el = $('ctx-list');
      if (!el) return;
      if (!contexts.length) { el.innerHTML = empty('没有保存的集群。点击"添加集群"导入 kubeconfig 或输入凭据。'); return; }
      el.innerHTML = contexts.map(c => {
        const src = c.source || 'kubeconfig';
        const srcBadge = src === 'token' ? '<span class="badge badge-warn">Token</span>' : src === 'cert' ? '<span class="badge badge-ok">Cert</span>' : c.system ? '<span class="badge badge-off">系统</span>' : '<span class="badge badge-ok">Kubeconfig</span>';
        return `<div class="row-item">
          <span class="row-dot" style="border-color:var(--accent)"></span>
          <div class="row-content">
            <div class="row-title"><strong>${esc(c.name)}</strong> ${srcBadge}</div>
            <div class="row-meta">
              <span>ns: ${esc(c.namespace || 'default')}</span>
              ${c.server ? `<span class="muted">${esc(c.server)}</span>` : c.kubeconfig ? `<span class="muted">${esc(c.kubeconfig)}</span>` : ''}
            </div>
          </div>
          <div class="row-actions">
            <button class="button" data-test-ctx="${esc(c.name)}">测试</button>
            <button class="button" data-overview-ctx="${esc(c.name)}">概览</button>
            <button class="button danger" data-del-ctx="${esc(c.name)}">删除</button>
          </div>
        </div>`;
      }).join('');

      el.querySelectorAll('[data-test-ctx]').forEach(b => b.onclick = async () => {
        b.disabled = true; b.textContent = '...';
        try {
          const r = await postJSON(API + '/k8s/contexts/' + encodeURIComponent(b.dataset.testCtx) + '/test', {});
          b.textContent = r.ok ? '✓ 连通' : '✗ 失败';
          b.style.color = r.ok ? 'var(--success)' : 'var(--danger)';
        } catch { b.textContent = '✗ 失败'; b.style.color = 'var(--danger)'; }
        setTimeout(() => { b.disabled = false; b.textContent = '测试'; b.style.color = ''; }, 3000);
      });

      el.querySelectorAll('[data-overview-ctx]').forEach(b => b.onclick = () => {
        selectedCtx = b.dataset.overviewCtx;
        k8sTab = 'overview'; renderK8s();
      });

      el.querySelectorAll('[data-del-ctx]').forEach(b => b.onclick = async () => {
        if (!confirm('删除集群 ' + b.dataset.delCtx + '？')) return;
        try { await deleteJSON(API + '/k8s/contexts/' + encodeURIComponent(b.dataset.delCtx)); toast('已删除'); await loadContexts(); renderContextList(); } catch (err) { toast(err.message); }
      });
    }

    // ── Overview Tab ──
    function renderOverview() {
      const c = $('k8s-content');
      c.innerHTML = `<div class="toolbar">
          <label style="font-size:12px;color:var(--muted)">集群 <select id="ov-ctx" style="margin-left:4px">${contextOptions()}</select></label>
          <button id="ov-go" class="button primary" style="margin-left:auto">加载概览</button>
        </div><div id="ov-result"></div>`;

      if (selectedCtx && $('ov-ctx')) $('ov-ctx').value = selectedCtx;

      $('ov-go').onclick = async () => {
        selectedCtx = $('ov-ctx').value;
        if (!selectedCtx) { toast('请选择集群'); return; }
        $('ov-go').disabled = true;
        $('ov-result').innerHTML = loading();
        try {
          const d = await postJSON(API + '/k8s/overview', { context: selectedCtx });
          $('ov-result').innerHTML = renderOverviewData(d);
          document.querySelectorAll('[data-ns-pick]').forEach(b => b.onclick = () => {
            selectedNs = b.dataset.nsPick;
            k8sTab = 'resources'; renderK8s();
          });
        } catch (err) { $('ov-result').innerHTML = errorHTML(err); }
        $('ov-go').disabled = false;
      };

      if (selectedCtx) $('ov-go').click();
    }

    function renderOverviewData(d) {
      let html = '';
      html += `<div class="overview-info">
        ${d.version?.server ? `<span>Server: ${esc(d.version.server)}</span>` : ''}
        ${d.version?.platform ? `<span>Platform: ${esc(d.version.platform)}</span>` : ''}
      </div>`;
      html += `<div class="stats">
        <div class="stat"><div class="stat-label">节点</div><div class="stat-value">${d.nodes?.ready || 0}<span style="font-size:14px;color:var(--muted)">/${d.nodes?.total || 0}</span></div><div class="stat-note">Ready / Total</div></div>
        <div class="stat"><div class="stat-label">Pod</div><div class="stat-value">${d.pods?.running || 0}<span style="font-size:14px;color:var(--muted)">/${d.pods?.total || 0}</span></div><div class="stat-note">${d.pods?.pending ? d.pods.pending + ' Pending ' : ''}${d.pods?.failed ? d.pods.failed + ' Failed' : ''}</div></div>
        <div class="stat"><div class="stat-label">Deployment</div><div class="stat-value">${d.deployments?.available || 0}<span style="font-size:14px;color:var(--muted)">/${d.deployments?.total || 0}</span></div><div class="stat-note">Available / Total</div></div>
        <div class="stat"><div class="stat-label">命名空间</div><div class="stat-value">${d.namespaces?.length || 0}</div><div class="stat-note">Namespaces</div></div>
      </div>`;

      if (d.namespaces?.length) {
        html += `<section class="panel" style="margin-bottom:16px"><div class="panel-head"><h3>命名空间</h3></div><div class="panel-body">
          <div class="ns-chips">${d.namespaces.map(n => `<button class="ns-chip" data-ns-pick="${esc(n)}">${esc(n)}</button>`).join('')}</div>
        </div></section>`;
      }

      if (d.events?.length) {
        html += `<section class="panel"><div class="panel-head"><h3>最近告警事件</h3></div><div class="panel-body overview-events">
          <table class="k8s-table"><thead><tr><th>类型</th><th>原因</th><th>对象</th><th>消息</th><th>次数</th><th>时间</th></tr></thead><tbody>
          ${d.events.map(e => `<tr style="${e.type === 'Warning' ? 'color:var(--danger)' : ''}">
            <td>${esc(e.type)}</td><td>${esc(e.reason)}</td><td style="font-size:11px">${esc(e.object)}</td><td class="wrap">${esc(e.message)}</td><td>${e.count}</td><td>${formatAge(e.lastTimestamp)}</td>
          </tr>`).join('')}
          </tbody></table></div></section>`;
      } else {
        html += `<section class="panel"><div class="panel-body">${empty('无告警事件')}</div></section>`;
      }

      return html;
    }

    // ── Resources Tab ──
    function renderResources() {
      const kindGroups = [
        { label: '工作负载', kinds: ['pods', 'deployments', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs'] },
        { label: '网络', kinds: ['services', 'ingresses'] },
        { label: '配置', kinds: ['configmaps', 'secrets'] },
        { label: '存储', kinds: ['pvc'] },
        { label: '集群', kinds: ['nodes', 'namespaces', 'hpa'] },
      ];
      const c = $('k8s-content');
      let resKind = 'pods';
      const sidebarHtml = kindGroups.map(g => `<div class="res-kind-group">
        <button class="res-kind-label" data-group-toggle><span class="group-arrow">▾</span> ${g.label}</button>
        <div class="res-kind-children">
          ${g.kinds.map(k => `<button class="res-kind-item${k === 'pods' ? ' active' : ''}" data-res-kind="${k}">${k}</button>`).join('')}
        </div>
      </div>`).join('');

      c.innerHTML =
        `<div class="res-toolbar">
          <label>集群 <select id="res-ctx">${contextOptions()}</select></label>
          <label>命名空间 <select id="res-ns"><option value="">加载中…</option></select></label>
          <div style="margin-left:auto"><button id="res-create-btn" class="button primary">+ 创建资源</button></div>
        </div>
        <div style="display:flex;gap:12px;margin-top:12px">
          <div class="res-kind-sidebar">${sidebarHtml}</div>
          <div id="res-result" style="flex:1;min-width:0"></div>
        </div>`;

      async function loadNamespaces() { await loadNsOptions('res-ns', 'res-ctx'); }

      loadNamespaces();
      $('res-ctx').onchange = () => { selectedCtx = $('res-ctx').value; loadNamespaces(); };
      $('res-ns').onchange = () => { selectedNs = $('res-ns').value; fetchResources(); };

      document.querySelectorAll('[data-group-toggle]').forEach(btn => {
        btn.onclick = () => {
          const group = btn.closest('.res-kind-group');
          const children = group.querySelector('.res-kind-children');
          const arrow = btn.querySelector('.group-arrow');
          const collapsed = children.style.display === 'none';
          children.style.display = collapsed ? '' : 'none';
          arrow.textContent = collapsed ? '▾' : '▸';
        };
      });

      document.querySelectorAll('[data-res-kind]').forEach(b => {
        b.onclick = () => {
          resKind = b.dataset.resKind;
          document.querySelectorAll('[data-res-kind]').forEach(x => x.classList.toggle('active', x === b));
          fetchResources();
        };
      });

      $('res-create-btn').onclick = () => {
        const templates = {
          deployment: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
      - name: my-app
        image: nginx:latest
        ports:
        - containerPort: 80`,
          service: `apiVersion: v1
kind: Service
metadata:
  name: my-service
  namespace: default
spec:
  selector:
    app: my-app
  ports:
  - port: 80
    targetPort: 80
  type: ClusterIP`,
          configmap: `apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
  namespace: default
data:
  key1: value1
  key2: value2`,
          blank: '',
        };

        showDetailPanel('创建资源', [{ label: 'Apply YAML', render: (body) => {
          body.innerHTML = `<div class="form-grid">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              <span style="font-size:12px;color:var(--muted);font-weight:500">模板</span>
              <button class="button" data-tpl="deployment" style="padding:2px 8px;font-size:10px">Deployment</button>
              <button class="button" data-tpl="service" style="padding:2px 8px;font-size:10px">Service</button>
              <button class="button" data-tpl="configmap" style="padding:2px 8px;font-size:10px">ConfigMap</button>
              <button class="button" data-tpl="blank" style="padding:2px 8px;font-size:10px">空白</button>
            </div>
            <label>YAML 清单<textarea id="apply-yaml" rows="16" style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:11px;line-height:1.5;tab-size:2" placeholder="粘贴或编写 YAML 资源定义…">${esc(templates.deployment)}</textarea></label>
            <div class="form-inline" style="gap:8px">
              <label>命名空间（可选覆盖）<select id="apply-ns"><option value="">使用 YAML 中的定义</option></select></label>
              <div></div>
            </div>
            <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px">
              <button id="apply-dry" class="button">干运行预览</button>
              <button id="apply-go" class="button primary">Apply</button>
            </div>
            <div id="apply-result"></div>
          </div>`;

          loadNsOptions('apply-ns', 'res-ctx');

          body.querySelectorAll('[data-tpl]').forEach(b => {
            b.onclick = () => { body.querySelector('#apply-yaml').value = templates[b.dataset.tpl]; };
          });

          body.querySelector('#apply-dry').onclick = async () => {
            const yaml = body.querySelector('#apply-yaml').value.trim();
            if (!yaml) { toast('请输入 YAML'); return; }
            const out = body.querySelector('#apply-result');
            out.innerHTML = loading();
            try {
              const r = await postJSON(API + '/k8s/apply', {
                context: selectedCtx, manifest: yaml,
                namespace: body.querySelector('#apply-ns').value || undefined,
                dry_run: true,
              });
              out.innerHTML = `<div class="notice" style="margin:0">${r.ok ? '干运行通过' : '干运行失败'}</div><pre style="margin-top:8px">${esc(r.output || '')}</pre>`;
            } catch (e) { out.innerHTML = errorHTML(e); }
          };

          body.querySelector('#apply-go').onclick = async () => {
            const yaml = body.querySelector('#apply-yaml').value.trim();
            if (!yaml) { toast('请输入 YAML'); return; }
            const out = body.querySelector('#apply-result');
            out.innerHTML = loading();
            try {
              const r = await postJSON(API + '/k8s/apply', {
                context: selectedCtx, manifest: yaml,
                namespace: body.querySelector('#apply-ns').value || undefined,
                dry_run: false,
              });
              if (r.ok) {
                out.innerHTML = `<div class="notice" style="margin:0">创建/更新成功</div><pre style="margin-top:8px">${esc(r.output || '')}</pre>`;
                toast('Apply 成功');
                fetchResources();
              } else {
                out.innerHTML = `<div class="notice error" style="margin:0">Apply 失败</div><pre style="margin-top:8px">${esc(r.output || '')}</pre>`;
              }
            } catch (e) { out.innerHTML = errorHTML(e); }
          };

          const ta = body.querySelector('#apply-yaml');
          ta.onkeydown = (e) => {
            if (e.key === 'Tab') {
              e.preventDefault();
              const start = ta.selectionStart;
              ta.value = ta.value.substring(0, start) + '  ' + ta.value.substring(ta.selectionEnd);
              ta.selectionStart = ta.selectionEnd = start + 2;
            }
          };
        }}]);
      };

      async function fetchResources() {
        selectedCtx = $('res-ctx').value;
        selectedNs = $('res-ns').value;
        $('res-result').innerHTML = loading();
        try {
          const isNsScoped = resKind !== 'nodes' && resKind !== 'namespaces';
          const ns = selectedNs || '';
          const payload = { context: selectedCtx, kind: resKind };
          if (isNsScoped) {
            if (ns) payload.namespace = ns;
            else payload.all_namespaces = true;
          }
          const r = await postJSON(API + '/k8s/resources', payload);
          if (!r.ok) { $('res-result').innerHTML = errorHTML({ message: r.stderr || '查询失败' }); return; }
          $('res-result').innerHTML = renderResourceTable(resKind, r.items || []);
          bindResourceActions(resKind);
        } catch (err) { $('res-result').innerHTML = errorHTML(err); }
      }

      fetchResources();
    }

    function renderResourceTable(kind, items) {
      if (!items.length) return `<section class="panel"><div class="panel-body">${empty('无资源')}</div></section>`;

      let headers, rows;
      const nm = (item) => item.metadata?.name || '';
      const ns = (item) => item.metadata?.namespace || '';
      const age = (item) => formatAge(item.metadata?.creationTimestamp);

      if (kind === 'pods') {
        headers = '<th></th><th>名称</th><th>命名空间</th><th>状态</th><th>Ready</th><th>重启</th><th>Age</th><th>Node</th><th></th>';
        rows = items.map(p => {
          const phase = podPhase(p);
          return `<tr>
            <td><span class="status-dot ${statusDotClass(phase)}"></span></td>
            <td><strong>${esc(nm(p))}</strong></td><td>${esc(ns(p))}</td>
            <td>${statusBadge(phase)}</td><td>${podReady(p)}</td><td>${podRestarts(p)}</td>
            <td>${age(p)}</td><td style="font-size:11px">${esc(p.spec?.nodeName || '')}</td>
            <td class="actions-cell">
              <button class="button" data-act="view" data-kind="pod" data-name="${esc(nm(p))}" data-ns="${esc(ns(p))}">查看</button>
              <button class="button danger" data-act="delete" data-kind="pod" data-name="${esc(nm(p))}" data-ns="${esc(ns(p))}">删除</button>
            </td></tr>`;
        });
      } else if (kind === 'deployments') {
        headers = '<th>名称</th><th>命名空间</th><th>Ready</th><th>Up-to-date</th><th>Available</th><th>Age</th><th></th>';
        rows = items.map(d => {
          const desired = d.spec?.replicas ?? 1;
          const ready = d.status?.readyReplicas ?? 0;
          const updated = d.status?.updatedReplicas ?? 0;
          const avail = d.status?.availableReplicas ?? 0;
          return `<tr>
            <td><strong>${esc(nm(d))}</strong></td><td>${esc(ns(d))}</td>
            <td>${ready}/${desired}</td><td>${updated}</td><td>${avail}</td><td>${age(d)}</td>
            <td class="actions-cell">
              <button class="button" data-act="scale" data-kind="deployment" data-name="${esc(nm(d))}" data-ns="${esc(ns(d))}" data-replicas="${desired}">缩放</button>
              <button class="button" data-act="restart" data-kind="deployment" data-name="${esc(nm(d))}" data-ns="${esc(ns(d))}">重启</button>
              <button class="button" data-act="view" data-kind="deployment" data-name="${esc(nm(d))}" data-ns="${esc(ns(d))}">查看</button>
              <button class="button danger" data-act="delete" data-kind="deployment" data-name="${esc(nm(d))}" data-ns="${esc(ns(d))}">删除</button>
            </td></tr>`;
        });
      } else if (kind === 'services') {
        headers = '<th>名称</th><th>命名空间</th><th>类型</th><th>Cluster-IP</th><th>Ports</th><th>Age</th><th></th>';
        rows = items.map(s => `<tr>
          <td><strong>${esc(nm(s))}</strong></td><td>${esc(ns(s))}</td>
          <td>${esc(s.spec?.type || 'ClusterIP')}</td><td>${esc(s.spec?.clusterIP || '')}</td>
          <td style="font-size:11px">${esc(extractPorts(s))}</td><td>${age(s)}</td>
          <td class="actions-cell">
            <button class="button" data-act="view" data-kind="service" data-name="${esc(nm(s))}" data-ns="${esc(ns(s))}">查看</button>
          </td></tr>`);
      } else if (kind === 'nodes') {
        headers = '<th></th><th>名称</th><th>状态</th><th>角色</th><th>版本</th><th>IP</th><th>Age</th><th></th>';
        rows = items.map(n => {
          const ready = nodeReady(n);
          return `<tr>
            <td><span class="status-dot ${ready ? 'ready' : 'notready'}"></span></td>
            <td><strong>${esc(nm(n))}</strong></td>
            <td>${ready ? statusBadge('Ready') : statusBadge('NotReady')}</td>
            <td>${esc(nodeRoles(n))}</td>
            <td>${esc(n.status?.nodeInfo?.kubeletVersion || '')}</td>
            <td style="font-size:11px">${esc((n.status?.addresses || []).find(a => a.type === 'InternalIP')?.address || '')}</td>
            <td>${age(n)}</td>
            <td class="actions-cell">
              <button class="button" data-act="view" data-kind="node" data-name="${esc(nm(n))}" data-ns="">查看</button>
            </td></tr>`;
        });
      } else {
        headers = '<th>名称</th><th>命名空间</th><th>Age</th><th></th>';
        rows = items.map(item => `<tr>
          <td><strong>${esc(nm(item))}</strong></td><td>${esc(ns(item))}</td><td>${age(item)}</td>
          <td class="actions-cell">
            <button class="button" data-act="view" data-kind="${esc(kind)}" data-name="${esc(nm(item))}" data-ns="${esc(ns(item))}">查看</button>
          </td></tr>`);
      }

      return `<section class="panel" style="margin-top:16px"><div class="panel-head"><h3>${esc(kind)} (${items.length})</h3></div>
        <div style="overflow-x:auto"><table class="k8s-table"><thead><tr>${headers}</tr></thead><tbody>${rows.join('')}</tbody></table></div></section>`;
    }

    function bindResourceActions(kind) {
      const el = $('res-result');
      if (!el) return;

      el.querySelectorAll('[data-act="view"]').forEach(b => {
        b.onclick = () => {
          const rKind = b.dataset.kind;
          const rName = b.dataset.name;
          const rNs = b.dataset.ns || undefined;
          const isPod = rKind === 'pod' || rKind === 'pods';
          const describeKind = rKind.endsWith('s') ? rKind.slice(0, -1) : rKind;
          const yamlKind = rKind.endsWith('s') ? rKind : rKind + 's';
          const tabs = [
            { label: '详情', load: async () => {
              const r = await postJSON(API + '/k8s/describe', { context: selectedCtx, kind: describeKind, name: rName, namespace: rNs });
              return `<pre>${esc(r.output || '')}</pre>`;
            }},
            { label: 'YAML', render: (body) => {
              body.innerHTML = loading();
              postJSON(API + '/k8s/resources', { context: selectedCtx, kind: yamlKind, name: rName, namespace: rNs }).then(r => {
                const yaml = r.output || '';
                body.innerHTML = `<div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:8px">
                  <button id="yaml-edit-btn" class="button">编辑</button>
                </div>
                <pre id="yaml-view">${esc(yaml)}</pre>
                <div id="yaml-editor" hidden>
                  <textarea id="yaml-ta" rows="20" style="width:100%;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:11px;line-height:1.5;tab-size:2">${esc(yaml)}</textarea>
                  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
                    <button id="yaml-cancel" class="button">取消</button>
                    <button id="yaml-dry" class="button">干运行</button>
                    <button id="yaml-apply" class="button primary">Apply</button>
                  </div>
                  <div id="yaml-result" style="margin-top:8px"></div>
                </div>`;

                body.querySelector('#yaml-edit-btn').onclick = () => {
                  body.querySelector('#yaml-view').hidden = true;
                  body.querySelector('#yaml-edit-btn').hidden = true;
                  body.querySelector('#yaml-editor').hidden = false;
                };
                body.querySelector('#yaml-cancel').onclick = () => {
                  body.querySelector('#yaml-view').hidden = false;
                  body.querySelector('#yaml-edit-btn').hidden = false;
                  body.querySelector('#yaml-editor').hidden = true;
                  body.querySelector('#yaml-ta').value = yaml;
                  body.querySelector('#yaml-result').innerHTML = '';
                };
                const doApply = async (dryRun) => {
                  const manifest = body.querySelector('#yaml-ta').value.trim();
                  if (!manifest) { toast('YAML 不能为空'); return; }
                  const out = body.querySelector('#yaml-result');
                  out.innerHTML = loading();
                  try {
                    const r = await postJSON(API + '/k8s/apply', { context: selectedCtx, manifest, dry_run: dryRun });
                    if (dryRun) {
                      out.innerHTML = `<div class="notice" style="margin:0">${r.ok ? '干运行通过' : '干运行失败'}</div><pre style="margin-top:6px">${esc(r.output || '')}</pre>`;
                    } else if (r.ok) {
                      out.innerHTML = `<div class="notice" style="margin:0">更新成功</div><pre style="margin-top:6px">${esc(r.output || '')}</pre>`;
                      toast('Apply 成功');
                    } else {
                      out.innerHTML = `<div class="notice error" style="margin:0">Apply 失败</div><pre style="margin-top:6px">${esc(r.output || '')}</pre>`;
                    }
                  } catch (e) { out.innerHTML = errorHTML(e); }
                };
                body.querySelector('#yaml-dry').onclick = () => doApply(true);
                body.querySelector('#yaml-apply').onclick = () => doApply(false);
                const ta = body.querySelector('#yaml-ta');
                ta.onkeydown = (e) => {
                  if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.value = ta.value.substring(0, s) + '  ' + ta.value.substring(ta.selectionEnd); ta.selectionStart = ta.selectionEnd = s + 2; }
                };
              }).catch(e => { body.innerHTML = errorHTML(e); });
            }},
          ];
          if (isPod) {
            tabs.push({ label: '日志', load: async () => {
              const r = await postJSON(API + '/k8s/logs', { context: selectedCtx, pod: rName, namespace: rNs, tail: 200 });
              return `<pre>${esc(r.output || '无日志')}</pre>`;
            }});
            tabs.push({ label: '终端', render: (body) => {
              body.innerHTML = `<div class="term-connect-box">
                <div class="form-inline" style="gap:8px;align-items:flex-end">
                  <label>Shell
                    <select id="term-shell-pick"><option>sh</option><option>bash</option><option>ash</option><option>/bin/sh</option><option>/bin/bash</option></select>
                  </label>
                  <button id="term-connect-btn" class="button primary" style="margin-bottom:1px">连接</button>
                </div>
                <div id="term-connect-status" style="margin-top:10px;font-size:12px;color:var(--muted)">选择 Shell 后点击连接</div>
              </div>
              <div id="term-workspace" hidden></div>`;

              let connectedShell = '';

              body.querySelector('#term-connect-btn').onclick = async () => {
                const shell = body.querySelector('#term-shell-pick').value;
                const status = body.querySelector('#term-connect-status');
                const btn = body.querySelector('#term-connect-btn');
                btn.disabled = true;
                status.innerHTML = loading();
                try {
                  const r = await postJSON(API + '/k8s/exec', { context: selectedCtx, pod: rName, namespace: rNs, command: 'echo __OK__', shell, timeout: 10 });
                  if (r.code !== 0) throw new Error(r.stderr || 'Shell 不可用');
                  connectedShell = shell;
                  body.querySelector('.term-connect-box').innerHTML = `<div class="notice" style="margin:0;padding:8px 12px"><strong>已连接</strong> · ${esc(rName)} · ${esc(shell)}</div>`;
                  initWorkspace();
                } catch (e) {
                  status.innerHTML = `<div class="notice error" style="margin:0">${esc(e.message || String(e))}<br><span style="font-size:11px;opacity:.7">该容器可能是 distroless 镜像，无可用 Shell</span></div>`;
                  btn.disabled = false;
                }
              };

              function initWorkspace() {
                const ws = body.querySelector('#term-workspace');
                ws.hidden = false;
                ws.innerHTML = `
                  <div class="term-section-tabs">
                    <button class="term-sec-tab active" data-sec="exec">执行命令</button>
                    <button class="term-sec-tab" data-sec="interactive">交互式终端</button>
                  </div>
                  <div id="term-sec-exec" class="term-section">
                    <div class="form-inline" style="gap:8px;margin-bottom:12px">
                      <label style="flex:1">命令<input id="exec-cmd-input" placeholder="ls -la /tmp" style="width:100%"></label>
                      <button id="exec-cmd-go" class="button primary" style="margin-top:18px">执行</button>
                    </div>
                    <div id="exec-cmd-output" style="font-size:11px;color:var(--muted)">输入命令后点击执行，或按 Enter</div>
                  </div>
                  <div id="term-sec-interactive" class="term-section" hidden>
                    <div style="display:flex;justify-content:flex-end;margin-bottom:6px">
                      <button id="term-clear-btn" class="button" style="padding:2px 10px;font-size:10px">清屏</button>
                    </div>
                    <div class="k8s-term-screen" id="term-screen">
                      <div class="term-line term-info">${esc(rName)} · ${esc(connectedShell)} · 输入命令按 Enter 执行</div>
                    </div>
                    <div class="k8s-term-input">
                      <span class="k8s-term-prompt">$</span>
                      <input id="term-cmd" placeholder="输入命令...">
                    </div>
                  </div>`;

                ws.querySelectorAll('.term-sec-tab').forEach(t => t.onclick = () => {
                  ws.querySelectorAll('.term-sec-tab').forEach(b => b.classList.toggle('active', b === t));
                  ws.querySelector('#term-sec-exec').hidden = t.dataset.sec !== 'exec';
                  ws.querySelector('#term-sec-interactive').hidden = t.dataset.sec !== 'interactive';
                  if (t.dataset.sec === 'interactive') setTimeout(() => ws.querySelector('#term-cmd')?.focus(), 50);
                });

                const execRun = async () => {
                  const cmd = ws.querySelector('#exec-cmd-input').value.trim();
                  if (!cmd) return;
                  const out = ws.querySelector('#exec-cmd-output');
                  out.innerHTML = loading();
                  try {
                    const r = await postJSON(API + '/k8s/exec', { context: selectedCtx, pod: rName, namespace: rNs, command: cmd, shell: connectedShell, timeout: 60 });
                    const badge = r.ok ? '<span class="badge badge-ok">exit 0</span>' : `<span class="badge badge-err">exit ${r.code}</span>`;
                    out.innerHTML = `<div style="margin-bottom:8px">${badge}</div><pre>${esc(r.stdout || '')}</pre>${r.stderr ? `<pre style="color:var(--danger);margin-top:8px">${esc(r.stderr)}</pre>` : ''}`;
                  } catch (e) { out.innerHTML = errorHTML(e); }
                };
                ws.querySelector('#exec-cmd-go').onclick = execRun;
                ws.querySelector('#exec-cmd-input').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); execRun(); } };

                const screen = ws.querySelector('#term-screen');
                const termInput = ws.querySelector('#term-cmd');
                const history = [];
                let histIdx = -1, running = false;

                function appendLine(text, cls) {
                  const div = document.createElement('div');
                  div.className = 'term-line' + (cls ? ' term-' + cls : '');
                  div.textContent = text;
                  screen.appendChild(div);
                  screen.scrollTop = screen.scrollHeight;
                }

                async function termRun() {
                  const cmd = termInput.value.trim();
                  if (!cmd || running) return;
                  history.unshift(cmd); histIdx = -1; termInput.value = '';
                  appendLine('$ ' + cmd, 'cmd');
                  if (cmd === 'clear') { screen.innerHTML = ''; return; }
                  running = true; termInput.disabled = true;
                  try {
                    const r = await postJSON(API + '/k8s/exec', { context: selectedCtx, pod: rName, namespace: rNs, command: cmd, shell: connectedShell, timeout: 60 });
                    if (r.stdout) appendLine(r.stdout);
                    if (r.stderr) appendLine(r.stderr, 'err');
                    if (r.code !== 0) appendLine(`[exit ${r.code}]`, 'exit');
                  } catch (e) { appendLine(e.message || String(e), 'err'); }
                  running = false; termInput.disabled = false; termInput.focus();
                }

                termInput.onkeydown = (e) => {
                  if (e.key === 'Enter') { e.preventDefault(); termRun(); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); if (history.length) { histIdx = Math.min(histIdx + 1, history.length - 1); termInput.value = history[histIdx]; } }
                  else if (e.key === 'ArrowDown') { e.preventDefault(); if (histIdx > 0) { histIdx--; termInput.value = history[histIdx]; } else { histIdx = -1; termInput.value = ''; } }
                };
                ws.querySelector('#term-clear-btn').onclick = () => { screen.innerHTML = ''; termInput.focus(); };
              }
            }});
          }
          showDetailPanel(rName, tabs);
        };
      });

      el.querySelectorAll('[data-act="delete"]').forEach(b => b.onclick = () => {
        const name = b.dataset.name;
        const kind = b.dataset.kind;
        const ns = b.dataset.ns;
        showDetailPanel(`删除 ${name}`, [{ label: '确认', render: (body) => {
          body.innerHTML = `<div class="form-grid">
            <div class="notice error" style="margin:0">确认删除 <strong>${esc(kind)}/${esc(name)}</strong>？此操作不可撤销。</div>
            <div class="actions" style="margin-top:8px">
              <button id="del-cancel" class="button">取消</button>
              <button id="del-go" class="button danger">确认删除</button>
            </div>
            <div id="del-status"></div>
          </div>`;
          body.querySelector('#del-cancel').onclick = () => {
            document.querySelector('#k8s-detail-panel')?.classList.remove('open');
            document.querySelector('#k8s-detail-backdrop')?.classList.remove('open');
          };
          body.querySelector('#del-go').onclick = async () => {
            body.querySelector('#del-status').innerHTML = loading();
            try {
              await postJSON(API + '/k8s/delete-resource', { context: selectedCtx, kind, name, namespace: ns || undefined });
              toast('已删除');
              document.querySelector('#k8s-detail-panel')?.classList.remove('open');
              document.querySelector('#k8s-detail-backdrop')?.classList.remove('open');
            } catch (err) {
              body.querySelector('#del-status').innerHTML = errorHTML(err);
            }
          };
        }}]);
      });

      el.querySelectorAll('[data-act="scale"]').forEach(b => b.onclick = () => {
        const cur = b.dataset.replicas || '1';
        const name = b.dataset.name;
        const kind = b.dataset.kind;
        const ns = b.dataset.ns;
        showDetailPanel(`缩放 ${name}`, [{ label: '缩放', render: (body) => {
          body.innerHTML = `<div class="form-grid">
            <p style="font-size:13px;color:var(--ink-secondary)">当前副本数：<strong>${esc(cur)}</strong></p>
            <label>目标副本数<input id="scale-input" type="number" min="0" value="${esc(cur)}" style="width:120px"></label>
            <div class="actions" style="margin-top:8px">
              <button id="scale-cancel" class="button">取消</button>
              <button id="scale-go" class="button primary">确认缩放</button>
            </div>
            <div id="scale-status"></div>
          </div>`;
          body.querySelector('#scale-cancel').onclick = () => {
            document.querySelector('#k8s-detail-panel')?.classList.remove('open');
            document.querySelector('#k8s-detail-backdrop')?.classList.remove('open');
          };
          body.querySelector('#scale-go').onclick = async () => {
            const n = parseInt(body.querySelector('#scale-input').value, 10);
            if (isNaN(n) || n < 0) { toast('请输入有效数字'); return; }
            body.querySelector('#scale-status').innerHTML = loading();
            try {
              await postJSON(API + '/k8s/scale', { context: selectedCtx, kind, name, namespace: ns, replicas: n });
              toast(`已缩放至 ${n} 副本`);
              body.querySelector('#scale-status').innerHTML = `<div class="notice" style="margin:0">已成功缩放至 ${n} 副本</div>`;
            } catch (err) {
              body.querySelector('#scale-status').innerHTML = errorHTML(err);
            }
          };
          body.querySelector('#scale-input').onkeydown = (e) => { if (e.key === 'Enter') body.querySelector('#scale-go').click(); };
          setTimeout(() => body.querySelector('#scale-input')?.focus(), 100);
        }}]);
      });

      el.querySelectorAll('[data-act="restart"]').forEach(b => b.onclick = async () => {
        if (!confirm(`确认重启 ${b.dataset.name}？`)) return;
        try {
          await postJSON(API + '/k8s/rollout', { context: selectedCtx, action: 'restart', kind: b.dataset.kind, name: b.dataset.name, namespace: b.dataset.ns });
          toast('已重启');
        } catch (err) { toast(err.message); }
      });
    }

    function showDetailPanel(title, tabDefs) {
      let panel = document.querySelector('#k8s-detail-panel');
      let backdrop = document.querySelector('#k8s-detail-backdrop');
      if (!panel) {
        backdrop = document.createElement('div');
        backdrop.id = 'k8s-detail-backdrop';
        backdrop.className = 'detail-panel-backdrop';
        document.body.appendChild(backdrop);
        panel = document.createElement('div');
        panel.id = 'k8s-detail-panel';
        panel.className = 'detail-panel';
        document.body.appendChild(panel);
      }
      const tabsHtml = tabDefs.map((t, i) => `<button class="dp-tab${i === 0 ? ' active' : ''}" data-dp-idx="${i}">${t.label}</button>`).join('');
      panel.innerHTML = `<div class="detail-panel-head"><h3>${title}</h3><button class="button" id="dp-close">关闭</button></div>
        <div class="detail-panel-tabs">${tabsHtml}</div>
        <div class="detail-panel-body" id="dp-body"></div>`;

      let activeIdx = 0;
      function showTab(idx) {
        activeIdx = idx;
        panel.querySelectorAll('.dp-tab').forEach((b, i) => b.classList.toggle('active', i === idx));
        const tab = tabDefs[idx];
        const body = panel.querySelector('#dp-body');
        if (tab.render) {
          body.innerHTML = '';
          tab.render(body);
        } else if (tab.content !== undefined) {
          body.innerHTML = `<pre>${esc(tab.content)}</pre>`;
        } else if (tab.load) {
          body.innerHTML = loading();
          tab.load().then(html => { if (activeIdx === idx) body.innerHTML = html; }).catch(e => { if (activeIdx === idx) body.innerHTML = errorHTML(e); });
        }
      }
      showTab(0);

      panel.querySelectorAll('.dp-tab').forEach(b => b.onclick = () => showTab(parseInt(b.dataset.dpIdx)));
      panel.querySelector('#dp-close').onclick = closePanel;
      backdrop.onclick = closePanel;
      requestAnimationFrame(() => { panel.classList.add('open'); backdrop.classList.add('open'); });

      function closePanel() {
        panel.classList.remove('open');
        backdrop.classList.remove('open');
      }
    }

    // ── Helm Tab ──
    let helmSubTab = 'releases';
    function renderHelm() {
      const c = $('k8s-content');
      c.innerHTML =
        `<div class="res-toolbar">
          <label>集群 <select id="helm-ctx">${contextOptions()}</select></label>
          <div style="margin-left:auto;display:flex;gap:8px">
            <button id="helm-refresh" class="button">刷新</button>
          </div>
        </div>
        <div class="term-section-tabs" style="margin-top:8px">
          <button class="term-sec-tab${helmSubTab==='releases'?' active':''}" data-helm-sub="releases">Releases</button>
          <button class="term-sec-tab${helmSubTab==='repos'?' active':''}" data-helm-sub="repos">仓库</button>
          <button class="term-sec-tab${helmSubTab==='search'?' active':''}" data-helm-sub="search">Chart 搜索</button>
        </div>
        <div id="helm-sub-content" style="margin-top:12px"></div>`;

      c.querySelectorAll('[data-helm-sub]').forEach(btn => btn.onclick = () => {
        helmSubTab = btn.dataset.helmSub;
        c.querySelectorAll('[data-helm-sub]').forEach(b => b.classList.toggle('active', b === btn));
        renderHelmSub();
      });

      $('helm-ctx').onchange = () => { selectedCtx = $('helm-ctx').value; renderHelmSub(); };
      $('helm-refresh').onclick = () => renderHelmSub();

      renderHelmSub();
    }

    function renderHelmSub() {
      if (helmSubTab === 'releases') renderHelmReleases();
      else if (helmSubTab === 'repos') renderHelmRepos();
      else if (helmSubTab === 'search') renderHelmSearch();
    }

    // ── Helm Releases Sub-tab ──
    function renderHelmReleases() {
      const wrap = $('helm-sub-content');
      wrap.innerHTML =
        `<div class="form-inline" style="margin-bottom:8px">
          <label>命名空间 <select id="helm-ns"><option value="">加载中…</option></select></label>
          <button id="helm-install-btn" class="button primary" style="margin-left:auto">+ 安装 Chart</button>
        </div>
        <div id="helm-result">${loading()}</div>`;

      loadNsOptions('helm-ns', 'helm-ctx');
      $('helm-ns').onchange = () => loadReleases();

      $('helm-install-btn').onclick = () => {
        showDetailPanel('安装 Helm Chart', [{ label: '安装', render: (body) => {
          body.innerHTML = `<div class="form-grid">
            <label>Release 名称 *<input id="inst-name" placeholder="my-release"></label>
            <label>Chart *<input id="inst-chart" placeholder="repo/chart 或 URL"></label>
            <label>版本<input id="inst-version" placeholder="留空=最新"></label>
            <label>命名空间<select id="inst-ns"><option value="">加载中…</option></select></label>
            <label>Values (YAML)<textarea id="inst-values" rows="8" style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:11px" placeholder="可选自定义配置"></textarea></label>
            <div style="display:flex;justify-content:flex-end;gap:8px">
              <button id="inst-dry" class="button">干运行</button>
              <button id="inst-go" class="button primary">安装</button>
            </div>
            <div id="inst-result"></div>
          </div>`;
          loadNsOptions('inst-ns', 'helm-ctx');
          const doInstall = async (dry) => {
            const name = body.querySelector('#inst-name').value.trim();
            const chart = body.querySelector('#inst-chart').value.trim();
            if (!name || !chart) { toast('请输入 Release 名称和 Chart'); return; }
            const out = body.querySelector('#inst-result');
            out.innerHTML = loading();
            try {
              const r = await postJSON(API + '/helm/install', {
                context: selectedCtx, release: name, chart,
                namespace: body.querySelector('#inst-ns').value || undefined,
                version: body.querySelector('#inst-version').value.trim() || undefined,
                values: body.querySelector('#inst-values').value.trim() || undefined,
                dry_run: dry,
              });
              out.innerHTML = `<div class="notice${r.ok ? '' : ' error'}" style="margin:0">${dry ? (r.ok ? '干运行通过' : '干运行失败') : (r.ok ? '安装成功' : '安装失败')}</div><pre style="margin-top:6px;max-height:300px;overflow:auto">${esc(r.output || '')}</pre>`;
              if (!dry && r.ok) { toast('安装成功'); loadReleases(); }
            } catch (e) { out.innerHTML = errorHTML(e); }
          };
          body.querySelector('#inst-dry').onclick = () => doInstall(true);
          body.querySelector('#inst-go').onclick = () => doInstall(false);
        }}]);
      };

      async function loadReleases() {
        selectedCtx = $('helm-ctx').value;
        const ns = $('helm-ns').value;
        $('helm-result').innerHTML = loading();
        try {
          const r = await postJSON(API + '/helm/list', { context: selectedCtx, namespace: ns || undefined });
          const items = r.items || [];
          if (!items.length) {
            $('helm-result').innerHTML = `<section class="panel"><div class="panel-body">${empty('无 Helm Release')}</div></section>`;
            return;
          }
          $('helm-result').innerHTML = `<section class="panel"><div class="panel-head"><h3>Releases (${items.length})</h3></div>
            <div style="overflow-x:auto"><table class="k8s-table"><thead><tr>
              <th>名称</th><th>命名空间</th><th>版本</th><th>状态</th><th>Chart</th><th>App Version</th><th>更新时间</th><th></th>
            </tr></thead><tbody>
            ${items.map(r => {
              const st = (r.status || '').toLowerCase();
              const stCls = st === 'deployed' ? 'badge-ok' : st === 'failed' ? 'badge-err' : 'badge-warn';
              const updated = r.info?.last_deployed ? formatAge(r.info.last_deployed) : (r.updated ? r.updated.substring(0, 19) : '-');
              return `<tr>
                <td><strong>${esc(r.name)}</strong></td>
                <td>${esc(r.namespace)}</td>
                <td>${r.revision || r.version || '-'}</td>
                <td><span class="badge ${stCls}">${esc(r.status)}</span></td>
                <td style="font-size:11px">${esc(r.chart)}</td>
                <td>${esc(r.app_version || '-')}</td>
                <td style="font-size:11px">${updated}</td>
                <td class="actions-cell">
                  <button class="button" data-helm-view="${esc(r.name)}" data-helm-ns="${esc(r.namespace)}">查看</button>
                  <button class="button" data-helm-upgrade="${esc(r.name)}" data-helm-ns="${esc(r.namespace)}" data-helm-chart="${esc(r.chart)}">升级</button>
                  <button class="button danger" data-helm-del="${esc(r.name)}" data-helm-ns="${esc(r.namespace)}">卸载</button>
                </td></tr>`;
            }).join('')}
            </tbody></table></div></section>`;
          bindHelmActions();
        } catch (err) { $('helm-result').innerHTML = errorHTML(err); }
      }

      function bindHelmActions() {
        const el = $('helm-result');

        el.querySelectorAll('[data-helm-view]').forEach(b => b.onclick = () => {
          const name = b.dataset.helmView;
          const ns = b.dataset.helmNs;
          showDetailPanel(name, [
            { label: '状态', load: async () => {
              const r = await postJSON(API + '/helm/status', { context: selectedCtx, release: name, namespace: ns });
              if (!r.ok) return `<div class="notice error">${esc(r.output || '查询失败')}</div>`;
              const d = r.data || {};
              const info = d.info || {};
              return `<div class="form-grid" style="gap:10px">
                <div class="status-line"><span>状态</span><span>${statusBadge(info.status || '-')}</span></div>
                <div class="status-line"><span>版本</span><span>${d.version || '-'}</span></div>
                <div class="status-line"><span>命名空间</span><span>${esc(d.namespace || ns)}</span></div>
                <div class="status-line"><span>最后部署</span><span>${esc(info.last_deployed || '-')}</span></div>
                <div class="status-line"><span>描述</span><span>${esc(info.description || '-')}</span></div>
                ${info.notes ? `<pre style="margin-top:8px;font-size:10px">${esc(info.notes)}</pre>` : ''}
              </div>`;
            }},
            { label: 'Values', load: async () => {
              const r = await postJSON(API + '/helm/values', { context: selectedCtx, release: name, namespace: ns, all: true });
              return `<pre>${esc(r.output || '无自定义 Values')}</pre>`;
            }},
            { label: '历史', load: async () => {
              const r = await postJSON(API + '/helm/history', { context: selectedCtx, release: name, namespace: ns });
              const items = r.items || [];
              if (!items.length) return empty('无历史记录');
              return `<table class="k8s-table"><thead><tr><th>版本</th><th>状态</th><th>Chart</th><th>App Version</th><th>描述</th></tr></thead><tbody>
                ${items.map(h => `<tr>
                  <td>${h.revision}</td>
                  <td><span class="badge ${h.status === 'deployed' ? 'badge-ok' : h.status === 'superseded' ? 'badge-off' : 'badge-warn'}">${esc(h.status)}</span></td>
                  <td style="font-size:11px">${esc(h.chart)}</td>
                  <td>${esc(h.app_version || '-')}</td>
                  <td class="wrap" style="font-size:11px">${esc(h.description || '')}</td>
                </tr>`).join('')}
              </tbody></table>`;
            }},
          ]);
        });

        el.querySelectorAll('[data-helm-upgrade]').forEach(b => b.onclick = () => {
          const name = b.dataset.helmUpgrade;
          const ns = b.dataset.helmNs;
          const chart = b.dataset.helmChart;
          showDetailPanel(`升级 ${name}`, [{ label: '升级', render: (body) => {
            body.innerHTML = `<div class="form-grid">
              <label>Release<input value="${esc(name)}" disabled></label>
              <label>Chart<input id="upg-chart" value="${esc(chart)}" placeholder="repo/chart 或本地路径"></label>
              <label>版本<input id="upg-version" placeholder="留空=最新"></label>
              <label class="toggle-row" style="font-size:12px"><input type="checkbox" id="upg-reuse" checked> 复用现有 Values</label>
              <label>自定义 Values (YAML)<textarea id="upg-values" rows="8" style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:11px" placeholder="可选覆盖"></textarea></label>
              <div style="display:flex;justify-content:flex-end;gap:8px">
                <button id="upg-dry" class="button">干运行</button>
                <button id="upg-go" class="button primary">升级</button>
              </div>
              <div id="upg-result"></div>
            </div>`;
            const doUpgrade = async (dry) => {
              const out = body.querySelector('#upg-result');
              out.innerHTML = loading();
              try {
                const r = await postJSON(API + '/helm/upgrade', {
                  context: selectedCtx, release: name, namespace: ns,
                  chart: body.querySelector('#upg-chart').value.trim(),
                  version: body.querySelector('#upg-version').value.trim() || undefined,
                  values: body.querySelector('#upg-values').value.trim() || undefined,
                  reuse_values: body.querySelector('#upg-reuse').checked,
                  dry_run: dry,
                });
                out.innerHTML = `<div class="notice${r.ok ? '' : ' error'}" style="margin:0">${dry ? (r.ok ? '干运行通过' : '干运行失败') : (r.ok ? '升级成功' : '升级失败')}</div><pre style="margin-top:6px;max-height:300px;overflow:auto">${esc(r.output || '')}</pre>`;
                if (!dry && r.ok) { toast('升级成功'); loadReleases(); }
              } catch (e) { out.innerHTML = errorHTML(e); }
            };
            body.querySelector('#upg-dry').onclick = () => doUpgrade(true);
            body.querySelector('#upg-go').onclick = () => doUpgrade(false);
          }}]);
        });

        el.querySelectorAll('[data-helm-del]').forEach(b => b.onclick = () => {
          const name = b.dataset.helmDel;
          const ns = b.dataset.helmNs;
          showDetailPanel(`卸载 ${name}`, [{ label: '确认', render: (body) => {
            body.innerHTML = `<div class="form-grid">
              <div class="notice error" style="margin:0">确认卸载 Helm Release <strong>${esc(name)}</strong>？所有相关 K8s 资源将被删除。</div>
              <div style="display:flex;justify-content:flex-end;gap:8px">
                <button id="hdel-cancel" class="button">取消</button>
                <button id="hdel-dry" class="button">干运行</button>
                <button id="hdel-go" class="button danger">确认卸载</button>
              </div>
              <div id="hdel-result"></div>
            </div>`;
            body.querySelector('#hdel-cancel').onclick = () => {
              document.querySelector('#k8s-detail-panel')?.classList.remove('open');
              document.querySelector('#k8s-detail-backdrop')?.classList.remove('open');
            };
            const doUninstall = async (dry) => {
              const out = body.querySelector('#hdel-result');
              out.innerHTML = loading();
              try {
                const r = await postJSON(API + '/helm/uninstall', { context: selectedCtx, release: name, namespace: ns, dry_run: dry });
                out.innerHTML = `<div class="notice${r.ok ? '' : ' error'}" style="margin:0">${dry ? (r.ok ? '干运行通过' : '失败') : (r.ok ? '已卸载' : '卸载失败')}</div><pre style="margin-top:6px">${esc(r.output || '')}</pre>`;
                if (!dry && r.ok) { toast('已卸载'); loadReleases(); }
              } catch (e) { out.innerHTML = errorHTML(e); }
            };
            body.querySelector('#hdel-dry').onclick = () => doUninstall(true);
            body.querySelector('#hdel-go').onclick = () => doUninstall(false);
          }}]);
        });
      }

      loadReleases();
    }

    // ── Helm Repos Sub-tab ──
    function renderHelmRepos() {
      const wrap = $('helm-sub-content');
      wrap.innerHTML =
        `<div class="form-inline" style="margin-bottom:8px;gap:8px">
          <button id="repo-update-btn" class="button">更新全部</button>
          <button id="repo-add-btn" class="button primary">+ 添加仓库</button>
        </div>
        <div id="repo-result">${loading()}</div>`;

      $('repo-add-btn').onclick = () => {
        showDetailPanel('添加 Helm 仓库', [{ label: '添加', render: (body) => {
          body.innerHTML = `<div class="form-grid">
            <label>仓库名称 *<input id="ra-name" placeholder="e.g. bitnami"></label>
            <label>仓库 URL *<input id="ra-url" placeholder="https://charts.bitnami.com/bitnami"></label>
            <div style="display:flex;justify-content:flex-end;gap:8px">
              <button id="ra-go" class="button primary">添加</button>
            </div>
            <div id="ra-result"></div>
          </div>`;
          body.querySelector('#ra-go').onclick = async () => {
            const name = body.querySelector('#ra-name').value.trim();
            const url = body.querySelector('#ra-url').value.trim();
            if (!name || !url) { toast('请填写名称和 URL'); return; }
            const out = body.querySelector('#ra-result');
            out.innerHTML = loading();
            try {
              const r = await postJSON(API + '/helm/repo-add', { name, url, force_update: true });
              out.innerHTML = `<div class="notice${r.ok ? '' : ' error'}" style="margin:0">${r.ok ? '添加成功' : '添加失败'}</div><pre style="margin-top:4px">${esc(r.output || '')}</pre>`;
              if (r.ok) { toast('仓库已添加'); loadRepos(); }
            } catch (e) { out.innerHTML = errorHTML(e); }
          };
        }}]);
      };

      $('repo-update-btn').onclick = async () => {
        $('repo-result').innerHTML = loading('更新中…');
        try {
          const r = await postJSON(API + '/helm/repo-update', {});
          if (r.ok) { toast('仓库已更新'); loadRepos(); }
          else { $('repo-result').innerHTML = `<div class="notice error">${esc(r.output || '更新失败')}</div>`; }
        } catch (e) { $('repo-result').innerHTML = errorHTML(e); }
      };

      async function loadRepos() {
        $('repo-result').innerHTML = loading();
        try {
          const r = await postJSON(API + '/helm/repo-list', {});
          const items = r.items || [];
          if (!items.length) {
            $('repo-result').innerHTML = `<section class="panel"><div class="panel-body">${empty('无 Helm 仓库，请先添加')}</div></section>`;
            return;
          }
          $('repo-result').innerHTML = `<section class="panel"><div class="panel-head"><h3>仓库列表 (${items.length})</h3></div>
            <div style="overflow-x:auto"><table class="k8s-table"><thead><tr>
              <th>名称</th><th>URL</th><th></th>
            </tr></thead><tbody>
            ${items.map(repo => `<tr>
              <td><strong>${esc(repo.name)}</strong></td>
              <td style="font-size:11px;word-break:break-all">${esc(repo.url)}</td>
              <td class="actions-cell">
                <button class="button" data-repo-charts="${esc(repo.name)}">浏览 Charts</button>
                <button class="button danger" data-repo-rm="${esc(repo.name)}">删除</button>
              </td>
            </tr>`).join('')}
            </tbody></table></div></section>`;

          $('repo-result').querySelectorAll('[data-repo-charts]').forEach(b => b.onclick = () => {
            helmSubTab = 'search';
            renderHelm();
            setTimeout(() => {
              const inp = $('chart-keyword');
              if (inp) { inp.value = b.dataset.repoCharts + '/'; doChartSearch(); }
            }, 100);
          });

          $('repo-result').querySelectorAll('[data-repo-rm]').forEach(b => b.onclick = async () => {
            const name = b.dataset.repoRm;
            showDetailPanel(`删除仓库 ${name}`, [{ label: '确认', render: (body) => {
              body.innerHTML = `<div class="form-grid">
                <div class="notice error" style="margin:0">确认删除 Helm 仓库 <strong>${esc(name)}</strong>？</div>
                <div style="display:flex;justify-content:flex-end;gap:8px">
                  <button id="rrm-cancel" class="button">取消</button>
                  <button id="rrm-go" class="button danger">确认删除</button>
                </div>
                <div id="rrm-result"></div>
              </div>`;
              body.querySelector('#rrm-cancel').onclick = () => {
                document.querySelector('#k8s-detail-panel')?.classList.remove('open');
                document.querySelector('#k8s-detail-backdrop')?.classList.remove('open');
              };
              body.querySelector('#rrm-go').onclick = async () => {
                const out = body.querySelector('#rrm-result');
                out.innerHTML = loading();
                try {
                  const r = await postJSON(API + '/helm/repo-remove', { name });
                  out.innerHTML = `<div class="notice${r.ok ? '' : ' error'}" style="margin:0">${r.ok ? '已删除' : '删除失败'}</div>`;
                  if (r.ok) { toast('仓库已删除'); loadRepos(); }
                } catch (e) { out.innerHTML = errorHTML(e); }
              };
            }}]);
          });
        } catch (err) { $('repo-result').innerHTML = errorHTML(err); }
      }

      loadRepos();
    }

    // ── Helm Chart Search Sub-tab ──
    function renderHelmSearch() {
      const wrap = $('helm-sub-content');
      wrap.innerHTML =
        `<div class="form-inline" style="margin-bottom:8px;gap:8px;align-items:flex-end">
          <label style="flex:1">关键词 <input id="chart-keyword" placeholder="输入 chart 名称搜索，例如 nginx 或 bitnami/nginx" style="width:100%"></label>
          <button id="chart-search-btn" class="button primary">搜索</button>
        </div>
        <div id="chart-result">${empty('输入关键词搜索 Chart')}</div>`;

      $('chart-search-btn').onclick = () => doChartSearch();
      $('chart-keyword').onkeydown = (e) => { if (e.key === 'Enter') doChartSearch(); };
    }

    async function doChartSearch() {
      const keyword = $('chart-keyword')?.value?.trim();
      if (!keyword) { toast('请输入搜索关键词'); return; }
      const result = $('chart-result');
      result.innerHTML = loading();
      try {
        const r = await postJSON(API + '/helm/search', { keyword });
        const items = r.items || [];
        if (!items.length) {
          result.innerHTML = `<section class="panel"><div class="panel-body">${empty('未找到匹配的 Chart')}</div></section>`;
          return;
        }
        result.innerHTML = `<section class="panel"><div class="panel-head"><h3>搜索结果 (${items.length})</h3></div>
          <div style="overflow-x:auto"><table class="k8s-table"><thead><tr>
            <th>Chart</th><th>版本</th><th>App Version</th><th>描述</th><th></th>
          </tr></thead><tbody>
          ${items.map(ch => `<tr>
            <td><strong>${esc(ch.name)}</strong></td>
            <td>${esc(ch.version || '-')}</td>
            <td>${esc(ch.app_version || '-')}</td>
            <td class="wrap" style="font-size:11px;max-width:300px">${esc(ch.description || '')}</td>
            <td class="actions-cell" style="white-space:nowrap">
              <button class="button" data-chart-versions="${esc(ch.name)}">版本</button>
              <button class="button" data-chart-info="${esc(ch.name)}" data-chart-ver="${esc(ch.version || '')}">详情</button>
              <button class="button primary" data-chart-install="${esc(ch.name)}" data-chart-ver="${esc(ch.version || '')}">安装</button>
            </td>
          </tr>`).join('')}
          </tbody></table></div></section>`;

        result.querySelectorAll('[data-chart-versions]').forEach(b => b.onclick = async () => {
          const chart = b.dataset.chartVersions;
          showDetailPanel(`${chart} 版本列表`, [{ label: '版本', load: async () => {
            const r = await postJSON(API + '/helm/search', { keyword: chart, versions: true });
            const items = (r.items || []).filter(i => i.name === chart);
            if (!items.length) return empty('无版本信息');
            return `<table class="k8s-table"><thead><tr><th>Chart 版本</th><th>App Version</th><th>描述</th><th></th></tr></thead><tbody>
              ${items.map(v => `<tr>
                <td><strong>${esc(v.version)}</strong></td>
                <td>${esc(v.app_version || '-')}</td>
                <td class="wrap" style="font-size:11px">${esc(v.description || '')}</td>
                <td class="actions-cell"><button class="button primary" data-vi-chart="${esc(chart)}" data-vi-ver="${esc(v.version)}">安装</button></td>
              </tr>`).join('')}
            </tbody></table>`;
          }}]);
          setTimeout(() => {
            document.querySelectorAll('[data-vi-chart]').forEach(ib => ib.onclick = () => {
              openHelmInstallPanel(ib.dataset.viChart, ib.dataset.viVer);
            });
          }, 500);
        });

        result.querySelectorAll('[data-chart-info]').forEach(b => b.onclick = async () => {
          const chart = b.dataset.chartInfo;
          const ver = b.dataset.chartVer;
          showDetailPanel(`${chart} 详情`, [
            { label: '基本信息', load: async () => {
              const r = await postJSON(API + '/helm/show', { chart, version: ver || undefined, sub: 'chart' });
              return `<pre style="white-space:pre-wrap">${esc(r.output || '无信息')}</pre>`;
            }},
            { label: 'Values', load: async () => {
              const r = await postJSON(API + '/helm/show', { chart, version: ver || undefined, sub: 'values' });
              return `<pre style="white-space:pre-wrap;max-height:500px;overflow:auto">${esc(r.output || '无默认 Values')}</pre>`;
            }},
            { label: 'README', load: async () => {
              const r = await postJSON(API + '/helm/show', { chart, version: ver || undefined, sub: 'readme' });
              return `<pre style="white-space:pre-wrap;max-height:500px;overflow:auto">${esc(r.output || '无 README')}</pre>`;
            }},
          ]);
        });

        result.querySelectorAll('[data-chart-install]').forEach(b => b.onclick = () => {
          openHelmInstallPanel(b.dataset.chartInstall, b.dataset.chartVer);
        });
      } catch (err) { result.innerHTML = errorHTML(err); }
    }

    function openHelmInstallPanel(chart, version) {
      showDetailPanel(`安装 ${chart}`, [{ label: '安装', render: (body) => {
        body.innerHTML = `<div class="form-grid">
          <label>Release 名称 *<input id="ci-name" placeholder="my-release"></label>
          <label>Chart<input id="ci-chart" value="${esc(chart)}" readonly></label>
          <label>版本<input id="ci-version" value="${esc(version || '')}" placeholder="留空=最新"></label>
          <label>命名空间<select id="ci-ns"><option value="">加载中…</option></select></label>
          <label>Values (YAML)<textarea id="ci-values" rows="8" style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:11px" placeholder="可选自定义配置"></textarea></label>
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button id="ci-dry" class="button">干运行</button>
            <button id="ci-go" class="button primary">安装</button>
          </div>
          <div id="ci-result"></div>
        </div>`;
        loadNsOptions('ci-ns', 'helm-ctx');
        const doInstall = async (dry) => {
          const name = body.querySelector('#ci-name').value.trim();
          if (!name) { toast('请输入 Release 名称'); return; }
          const out = body.querySelector('#ci-result');
          out.innerHTML = loading();
          try {
            const r = await postJSON(API + '/helm/install', {
              context: selectedCtx,
              release: name,
              chart: body.querySelector('#ci-chart').value.trim(),
              namespace: body.querySelector('#ci-ns').value || undefined,
              version: body.querySelector('#ci-version').value.trim() || undefined,
              values: body.querySelector('#ci-values').value.trim() || undefined,
              dry_run: dry,
            });
            out.innerHTML = `<div class="notice${r.ok ? '' : ' error'}" style="margin:0">${dry ? (r.ok ? '干运行通过' : '干运行失败') : (r.ok ? '安装成功' : '安装失败')}</div><pre style="margin-top:6px;max-height:300px;overflow:auto">${esc(r.output || '')}</pre>`;
            if (!dry && r.ok) toast('安装成功');
          } catch (e) { out.innerHTML = errorHTML(e); }
        };
        body.querySelector('#ci-dry').onclick = () => doInstall(true);
        body.querySelector('#ci-go').onclick = () => doInstall(false);
      }}]);
    }

    // ── Logs Tab ──
    function renderLogs() {
      const c = $('k8s-content');
      c.innerHTML =
        `<section class="panel"><div class="panel-head"><h3>Pod 日志</h3></div><div class="panel-body form-grid">
          <div class="form-inline">
            <label>集群<select id="log-ctx">${contextOptions()}</select></label>
            <label>命名空间<select id="log-ns"><option value="">加载中…</option></select></label>
          </div>
          <div class="form-inline">
            <label>Pod<select id="log-pod"><option value="">-- 先选择命名空间 --</option></select></label>
            <label>容器<select id="log-container"><option value="">全部</option></select></label>
          </div>
          <div class="form-inline">
            <label>行数<input id="log-tail" type="number" value="200"></label>
            <label>时间范围<input id="log-since" placeholder="10m, 2h"></label>
          </div>
          <div style="display:flex;align-items:center;justify-content:flex-end;gap:16px">
            <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);cursor:pointer" title="查看容器上次崩溃（CrashLoopBackOff）时的日志，等同于 kubectl logs --previous">上次崩溃日志 <input type="checkbox" id="log-prev" style="margin:0"></label>
            <button id="log-go" class="button primary">获取日志</button>
          </div>
        </div></section>
        <div id="log-result"></div>`;

      let logPodItems = [];

      async function loadLogPods() {
        const ctx = $('log-ctx').value;
        const ns = $('log-ns').value;
        $('log-pod').innerHTML = '<option value="">加载中…</option>';
        if (!ns) { $('log-pod').innerHTML = '<option value="">-- 先选择命名空间 --</option>'; return; }
        try {
          const r = await postJSON(API + '/k8s/resources', { context: ctx, kind: 'pods', namespace: ns });
          logPodItems = r.items || [];
          $('log-pod').innerHTML = logPodItems.map(p => `<option value="${esc(p.metadata?.name)}">${esc(p.metadata?.name)} (${podPhase(p)})</option>`).join('') || '<option value="">无 Pod</option>';
          if (logPodItems.length) loadLogContainers(logPodItems[0]);
        } catch (err) { $('log-pod').innerHTML = '<option value="">加载失败</option>'; }
      }

      function loadLogContainers(podData) {
        if (!podData) { $('log-container').innerHTML = '<option value="">全部</option>'; return; }
        const containers = (podData.spec?.containers || []).map(c => c.name);
        const initContainers = (podData.spec?.initContainers || []).map(c => c.name);
        $('log-container').innerHTML = `<option value="">全部</option>` + [...containers, ...initContainers].map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
      }

      loadNsOptions('log-ns', 'log-ctx');
      $('log-ctx').onchange = () => { loadNsOptions('log-ns', 'log-ctx'); };
      $('log-ns').onchange = () => loadLogPods();
      $('log-pod').onchange = () => {
        const pod = logPodItems.find(p => p.metadata?.name === $('log-pod').value);
        loadLogContainers(pod);
      };

      $('log-go').onclick = async () => {
        const pod = $('log-pod').value;
        if (!pod) { toast('请先选择 Pod'); return; }
        const btn = $('log-go'); btn.disabled = true;
        $('log-result').innerHTML = loading();
        try {
          const r = await postJSON(API + '/k8s/logs', {
            context: $('log-ctx').value, namespace: $('log-ns').value, pod,
            container: $('log-container').value || undefined,
            tail: Number($('log-tail').value) || 200,
            since: $('log-since').value || undefined,
            previous: $('log-prev').checked,
          });
          $('log-result').innerHTML = `<section class="panel"><div class="panel-head"><h3>${esc(pod)}</h3></div>
            <div class="panel-body"><pre>${esc(r.output || '无日志')}</pre></div></section>`;
        } catch (err) { $('log-result').innerHTML = errorHTML(err); }
        btn.disabled = false;
      };
    }

    // ── Exec Tab ──
    function renderExec() {
      const c = $('k8s-content');
      c.innerHTML =
        `<section class="panel"><div class="panel-head"><h3>容器执行</h3></div><div class="panel-body form-grid">
          <div class="form-inline">
            <label>集群<select id="exec-ctx">${contextOptions()}</select></label>
            <label>命名空间<select id="exec-ns"><option value="">加载中…</option></select></label>
          </div>
          <div class="form-inline">
            <label>Pod<select id="exec-pod"><option value="">-- 先选择命名空间 --</option></select></label>
            <label>容器<select id="exec-container"><option value="">默认</option></select></label>
          </div>
          <div class="form-inline">
            <label>超时(秒)<input id="exec-timeout" type="number" value="60"></label>
            <label></label>
          </div>
          <label>命令 *<textarea id="exec-cmd" rows="3" placeholder="ls -la /tmp" required></textarea></label>
          <div class="actions"><button id="exec-go" class="button primary">执行</button></div>
        </div></section>
        <div id="exec-result"></div>`;

      let execPodItems = [];

      async function loadExecPods() {
        const ctx = $('exec-ctx').value;
        const ns = $('exec-ns').value;
        $('exec-pod').innerHTML = '<option value="">加载中…</option>';
        if (!ns) { $('exec-pod').innerHTML = '<option value="">-- 先选择命名空间 --</option>'; return; }
        try {
          const r = await postJSON(API + '/k8s/resources', { context: ctx, kind: 'pods', namespace: ns });
          execPodItems = (r.items || []).filter(p => p.status?.phase === 'Running');
          $('exec-pod').innerHTML = execPodItems.map(p => `<option value="${esc(p.metadata?.name)}">${esc(p.metadata?.name)}</option>`).join('') || '<option value="">无运行中的 Pod</option>';
          if (execPodItems.length) {
            const containers = (execPodItems[0].spec?.containers || []).map(c => c.name);
            $('exec-container').innerHTML = `<option value="">默认</option>` + containers.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
          }
        } catch { $('exec-pod').innerHTML = '<option value="">加载失败</option>'; }
      }

      loadNsOptions('exec-ns', 'exec-ctx');
      $('exec-ctx').onchange = () => { loadNsOptions('exec-ns', 'exec-ctx'); };
      $('exec-ns').onchange = () => loadExecPods();
      $('exec-pod').onchange = () => {
        const pod = execPodItems.find(p => p.metadata?.name === $('exec-pod').value);
        if (pod) {
          const containers = (pod.spec?.containers || []).map(c => c.name);
          $('exec-container').innerHTML = `<option value="">默认</option>` + containers.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
        }
      };

      $('exec-go').onclick = async () => {
        const pod = $('exec-pod').value;
        const cmd = $('exec-cmd').value.trim();
        if (!pod) { toast('请先选择 Pod'); return; }
        if (!cmd) { toast('请输入命令'); return; }
        const btn = $('exec-go'); btn.disabled = true;
        $('exec-result').innerHTML = loading();
        try {
          const r = await postJSON(API + '/k8s/exec', {
            context: $('exec-ctx').value, pod, namespace: $('exec-ns').value,
            container: $('exec-container').value || undefined,
            command: cmd, timeout: Number($('exec-timeout').value) || 60,
          });
          const badge = r.ok ? '<span class="badge badge-ok">exit 0</span>' : `<span class="badge badge-err">exit ${r.code}</span>`;
          $('exec-result').innerHTML = `<section class="panel"><div class="panel-head"><h3>${esc(pod)} ${badge}</h3></div>
            <div class="panel-body"><pre>${esc(r.stdout || '')}</pre>${r.stderr ? `<pre style="color:var(--danger);margin-top:8px">${esc(r.stderr)}</pre>` : ''}</div></section>`;
        } catch (err) { $('exec-result').innerHTML = errorHTML(err); }
        btn.disabled = false;
      };
    }

    // ── Events Tab ──
    function renderEvents() {
      const c = $('k8s-content');
      c.innerHTML =
        `<section class="panel"><div class="panel-head"><h3>集群事件</h3></div><div class="panel-body form-grid">
          <div class="form-inline">
            <label>集群<select id="evt-ctx">${contextOptions()}</select></label>
            <label>命名空间<select id="evt-ns"><option value="">加载中…</option></select></label>
          </div>
          <div class="command-tabs">
            <button class="chip active" data-evt-type="Warning">Warning</button>
            <button class="chip" data-evt-type="Normal">Normal</button>
            <button class="chip" data-evt-type="">全部</button>
          </div>
          <div class="actions"><button id="evt-go" class="button primary">查询事件</button></div>
        </div></section>
        <div id="evt-result"></div>`;

      loadNsOptions('evt-ns', 'evt-ctx');
      $('evt-ctx').onchange = () => loadNsOptions('evt-ns', 'evt-ctx');

      let evtType = 'Warning';
      document.querySelectorAll('[data-evt-type]').forEach(b => b.onclick = () => {
        evtType = b.dataset.evtType;
        document.querySelectorAll('[data-evt-type]').forEach(x => x.classList.toggle('active', x === b));
      });

      $('evt-go').onclick = async () => {
        selectedCtx = $('evt-ctx').value;
        const btn = $('evt-go'); btn.disabled = true;
        $('evt-result').innerHTML = loading();
        try {
          const ns = $('evt-ns').value;
          const r = await postJSON(API + '/k8s/events', { context: selectedCtx, namespace: ns || undefined, all_namespaces: !ns, type: evtType || undefined });
          const items = r.items || [];
          if (!items.length) { $('evt-result').innerHTML = `<section class="panel"><div class="panel-body">${empty('无事件')}</div></section>`; }
          else {
            $('evt-result').innerHTML = `<section class="panel"><div class="panel-head"><h3>事件 (${items.length})</h3></div>
              <div style="overflow-x:auto"><table class="k8s-table"><thead><tr><th>类型</th><th>原因</th><th>命名空间</th><th>对象</th><th>消息</th><th>次数</th><th>时间</th></tr></thead><tbody>
              ${items.map(e => `<tr style="${e.type === 'Warning' ? 'color:var(--danger)' : ''}">
                <td>${esc(e.type)}</td><td>${esc(e.reason)}</td><td>${esc(e.namespace)}</td><td style="font-size:11px">${esc(e.object)}</td>
                <td class="wrap">${esc(e.message)}</td><td>${e.count}</td><td>${formatAge(e.lastTimestamp)}</td></tr>`).join('')}
              </tbody></table></div></section>`;
          }
        } catch (err) { $('evt-result').innerHTML = errorHTML(err); }
        btn.disabled = false;
      };
    }

    await loadContexts();
    if (contexts.length && !selectedCtx) selectedCtx = contexts[0].name;
    renderK8s();
  }

  // ============================================================
  // ARGO CD PAGE
  // ============================================================
  async function argocdPage(token) {
    let aTab = 'instances';
    let instances = [];

    async function loadInstances() {
      try { instances = await fetchJSON(API + '/argocd/instances'); } catch { instances = []; }
    }

    function renderArgocd() {
      if (token !== generation) return;
      $('main').innerHTML = title('Argo CD', 'GITOPS CONTINUOUS DEPLOYMENT', '应用同步状态管理') +
        tabs([['instances', '实例'], ['apps', '应用']], aTab, 'data-acd-tab') +
        '<div id="acd-content"></div>';

      document.querySelectorAll('[data-acd-tab]').forEach(b => b.onclick = () => { aTab = b.dataset.acdTab; renderArgocd(); });

      if (aTab === 'instances') renderAcdInstances();
      else renderAcdApps();
    }

    function renderAcdInstances() {
      const c = $('acd-content');
      c.innerHTML =
        `<div class="toolbar"><button id="add-acd-btn" class="button primary">＋ 添加实例</button></div>` +
        `<section id="add-acd-form" class="panel" hidden><div class="panel-head"><h3>添加 Argo CD 实例</h3></div>
          <form id="acd-form" class="panel-body form-grid">
            <div class="form-inline">
              <label>名称 *<input name="name" required placeholder="production"></label>
              <label>服务器地址 *<input name="server" required placeholder="https://argocd.example.com"></label>
            </div>
            <div class="actions"><button type="button" id="cancel-acd" class="button">取消</button><button type="submit" class="button primary">保存</button></div>
          </form></section>` +
        `<div id="acd-list">${loading()}</div>`;

      $('add-acd-btn').onclick = () => { $('add-acd-form').hidden = !$('add-acd-form').hidden; };
      $('cancel-acd').onclick = () => { $('add-acd-form').hidden = true; };
      $('acd-form').onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        try {
          await postJSON(API + '/argocd/instances', { name: fd.get('name'), server: fd.get('server') });
          toast('实例已添加'); $('add-acd-form').hidden = true; e.target.reset();
          await loadInstances(); renderAcdList();
        } catch (err) { toast(err.message); }
      };

      loadInstances().then(renderAcdList);
    }

    function renderAcdList() {
      const el = $('acd-list');
      if (!el) return;
      if (!instances.length) { el.innerHTML = empty('没有 Argo CD 实例。'); return; }
      el.innerHTML = instances.map(inst => `<div class="row-item">
        <span class="row-dot" style="border-color:var(--accent)"></span>
        <div class="row-content">
          <div class="row-title"><strong>${esc(inst.name)}</strong></div>
          <div class="row-meta"><span>${esc(inst.server)}</span></div>
        </div>
        <button class="button" data-del-acd="${esc(inst.name)}">删除</button>
      </div>`).join('');

      el.querySelectorAll('[data-del-acd]').forEach(b => b.onclick = async () => {
        if (!confirm('删除实例 ' + b.dataset.delAcd + '？')) return;
        try { await deleteJSON(API + '/argocd/instances/' + encodeURIComponent(b.dataset.delAcd)); toast('已删除'); await loadInstances(); renderAcdList(); } catch (err) { toast(err.message); }
      });
    }

    function renderAcdApps() {
      const c = $('acd-content');
      c.innerHTML =
        `<section class="panel"><div class="panel-body form-grid">
          <div class="form-inline">
            <label>实例<select id="acd-inst">${instances.map(i => `<option value="${esc(i.name)}">${esc(i.name)}</option>`).join('')}</select></label>
          </div>
          <div class="actions"><button id="acd-load-apps" class="button primary">加载应用</button></div>
        </div></section>
        <div id="acd-apps-result"></div>`;

      $('acd-load-apps').onclick = async () => {
        const inst = $('acd-inst').value;
        if (!inst) { toast('请选择实例'); return; }
        const btn = $('acd-load-apps'); btn.disabled = true;
        $('acd-apps-result').innerHTML = loading();
        try {
          const r = await postJSON(API + '/argocd/apps', { instance: inst });
          const apps = r.apps || [];
          if (Array.isArray(apps) && apps.length) {
            $('acd-apps-result').innerHTML = `<section class="panel"><div class="panel-head"><h3>应用列表</h3><span class="badge badge-off">${apps.length} 个应用</span></div>
              ${apps.map(a => {
                const name = a.metadata?.name || a.name || '?';
                const sync = a.status?.sync?.status || 'Unknown';
                const health = a.status?.health?.status || 'Unknown';
                return `<div class="row-item">
                  <div class="row-content">
                    <div class="row-title"><strong>${esc(name)}</strong></div>
                    <div class="row-meta">${statusBadge(sync)} ${statusBadge(health)}</div>
                  </div></div>`;
              }).join('')}
            </section>`;
          } else {
            $('acd-apps-result').innerHTML = `<section class="panel"><div class="panel-head"><h3>应用列表</h3></div>
              <div class="panel-body"><pre>${esc(r.raw || json(r))}</pre></div></section>`;
          }
        } catch (err) { $('acd-apps-result').innerHTML = errorHTML(err); }
        btn.disabled = false;
      };
    }

    await loadInstances();
    renderArgocd();
  }

  // ============================================================
  // ARGO WORKFLOWS PAGE
  // ============================================================
  async function argowfPage(token) {
    let wfTab = 'instances';
    let instances = [];

    async function loadInstances() {
      try { instances = await fetchJSON(API + '/argowf/instances'); } catch { instances = []; }
    }

    function renderArgowf() {
      if (token !== generation) return;
      $('main').innerHTML = title('Workflows', 'ARGO WORKFLOWS', '工作流引擎管理') +
        tabs([['instances', '实例'], ['workflows', '工作流']], wfTab, 'data-wf-tab') +
        '<div id="wf-content"></div>';

      document.querySelectorAll('[data-wf-tab]').forEach(b => b.onclick = () => { wfTab = b.dataset.wfTab; renderArgowf(); });

      if (wfTab === 'instances') renderWfInstances();
      else renderWfList();
    }

    function renderWfInstances() {
      const c = $('wf-content');
      c.innerHTML =
        `<div class="toolbar"><button id="add-wf-btn" class="button primary">＋ 添加实例</button></div>` +
        `<section id="add-wf-form" class="panel" hidden><div class="panel-head"><h3>添加 Argo Workflows 实例</h3></div>
          <form id="wf-form" class="panel-body form-grid">
            <div class="form-inline">
              <label>名称 *<input name="name" required placeholder="production"></label>
              <label>服务器地址 *<input name="server" required placeholder="https://argo.example.com"></label>
            </div>
            <label>默认命名空间<input name="namespace" value="argo"></label>
            <div class="actions"><button type="button" id="cancel-wf" class="button">取消</button><button type="submit" class="button primary">保存</button></div>
          </form></section>` +
        `<div id="wf-list">${loading()}</div>`;

      $('add-wf-btn').onclick = () => { $('add-wf-form').hidden = !$('add-wf-form').hidden; };
      $('cancel-wf').onclick = () => { $('add-wf-form').hidden = true; };
      $('wf-form').onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        try {
          await postJSON(API + '/argowf/instances', { name: fd.get('name'), server: fd.get('server'), namespace: fd.get('namespace') || 'argo' });
          toast('实例已添加'); $('add-wf-form').hidden = true; e.target.reset();
          await loadInstances(); renderWfInstanceList();
        } catch (err) { toast(err.message); }
      };

      loadInstances().then(renderWfInstanceList);
    }

    function renderWfInstanceList() {
      const el = $('wf-list');
      if (!el) return;
      if (!instances.length) { el.innerHTML = empty('没有 Argo Workflows 实例。'); return; }
      el.innerHTML = instances.map(inst => `<div class="row-item">
        <span class="row-dot" style="border-color:var(--accent)"></span>
        <div class="row-content">
          <div class="row-title"><strong>${esc(inst.name)}</strong></div>
          <div class="row-meta"><span>${esc(inst.server)}</span><span>ns: ${esc(inst.namespace || 'argo')}</span></div>
        </div>
        <button class="button" data-del-wf="${esc(inst.name)}">删除</button>
      </div>`).join('');

      el.querySelectorAll('[data-del-wf]').forEach(b => b.onclick = async () => {
        if (!confirm('删除实例 ' + b.dataset.delWf + '？')) return;
        try { await deleteJSON(API + '/argowf/instances/' + encodeURIComponent(b.dataset.delWf)); toast('已删除'); await loadInstances(); renderWfInstanceList(); } catch (err) { toast(err.message); }
      });
    }

    function renderWfList() {
      const c = $('wf-content');
      const phases = ['', 'Running', 'Succeeded', 'Failed', 'Error'];
      c.innerHTML =
        `<section class="panel"><div class="panel-body form-grid">
          <div class="form-inline">
            <label>实例<select id="wf-inst">${instances.map(i => `<option value="${esc(i.name)}">${esc(i.name)}</option>`).join('')}</select></label>
            <label>命名空间<input id="wf-ns" placeholder="默认"></label>
          </div>
          <div class="command-tabs">${phases.map(p => `<button class="chip ${!p ? 'active' : ''}" data-wf-phase="${p}">${p || '全部'}</button>`).join('')}</div>
          <div class="actions"><button id="wf-load" class="button primary">加载工作流</button></div>
        </div></section>
        <div id="wf-result"></div>`;

      let selPhase = '';
      document.querySelectorAll('[data-wf-phase]').forEach(b => b.onclick = () => {
        selPhase = b.dataset.wfPhase;
        document.querySelectorAll('[data-wf-phase]').forEach(x => x.classList.toggle('active', x === b));
      });

      $('wf-load').onclick = async () => {
        const inst = $('wf-inst').value;
        if (!inst) { toast('请选择实例'); return; }
        const btn = $('wf-load'); btn.disabled = true;
        $('wf-result').innerHTML = loading();
        try {
          const body = { instance: inst };
          if ($('wf-ns').value) body.namespace = $('wf-ns').value;
          if (selPhase) body.status = selPhase;
          const r = await postJSON(API + '/argowf/list', body);
          $('wf-result').innerHTML = `<section class="panel"><div class="panel-head"><h3>工作流</h3></div>
            <div class="panel-body"><pre>${esc(r.text || r.output || json(r))}</pre></div></section>`;
        } catch (err) { $('wf-result').innerHTML = errorHTML(err); }
        btn.disabled = false;
      };
    }

    await loadInstances();
    renderArgowf();
  }

  // ============================================================
  // SETTINGS PAGE
  // ============================================================
  async function settingsPage(token) {
    $('main').innerHTML = loading();
    let status;
    try { status = await fetchJSON(API + '/status'); } catch (e) {
      if (token === generation) $('main').innerHTML = title('设置', 'SETTINGS', '模块管理与配置') + errorHTML(e);
      return;
    }
    if (token !== generation) return;
    meta = status;

    function render() {
      $('main').innerHTML = title('设置', 'SETTINGS', '模块管理与配置') +
        `<section class="panel"><div class="panel-head"><h3>模块管理</h3><span class="badge badge-off">${MODULES.length} 个模块</span></div>
          ${MODULES.map(m => {
            const dep = status.deps?.[m.bin];
            const enabled = m.key === 'ssh' || m.key === 'k8s' ? status.config?.[m.key]?.enabled !== false : !!status.config?.[m.key]?.enabled;
            return `<div class="row-item">
              <div class="row-content">
                <div class="row-title"><strong>${esc(m.label)}</strong> <span class="muted">— ${esc(m.desc)}</span></div>
                <div class="row-meta">
                  <code style="font-size:11px">${esc(m.bin)}</code>
                  ${dep?.ok ? `<span class="badge badge-ok">${esc(dep.path)}</span>` : enabled ? '<span class="badge badge-err">未安装</span>' : '<span class="badge badge-off">未启用</span>'}
                </div>
              </div>
              <button class="toggle-btn ${enabled ? 'on' : ''}" data-toggle-mod="${esc(m.key)}" data-toggle-state="${enabled}">
                <span class="toggle-dot"></span>
              </button>
            </div>`;
          }).join('')}
        </section>` +
        `<div class="notice" style="margin-top:16px">开关切换后需要重启 DSH 才生效。数据目录：~/.dsh/dsh-ops/</div>` +
        `<section class="panel" style="margin-top:16px"><div class="panel-head"><h3>运行信息</h3></div><div class="panel-body">
          <div class="status-line"><span>已注册工具</span><span>${status.toolCount || 0}</span></div>
          <div class="status-line"><span>数据目录</span><span>~/.dsh/dsh-ops/</span></div>
        </div></section>`;

      document.querySelectorAll('[data-toggle-mod]').forEach(b => b.onclick = async () => {
        const mod = b.dataset.toggleMod;
        const newState = b.dataset.toggleState !== 'true';
        b.disabled = true;
        try {
          const r = await postJSON(API + '/config', { module: mod, enabled: newState });
          status.config = r.config || status.config;
          toast(newState ? '已启用 ' + mod : '已禁用 ' + mod);
          render();
        } catch (err) { toast(err.message); b.disabled = false; }
      });
    }

    render();
  }

  // ============================================================
  // NAVIGATION & BOOT
  // ============================================================
  async function navigate(name) {
    page = pages.some(p => p[0] === name) ? name : 'dashboard';
    const token = ++generation;
    history.replaceState(null, '', '#' + page);
    const found = pages.find(p => p[0] === page);
    $('crumb').textContent = found ? found[2] : '仪表盘';
    document.querySelectorAll('[data-nav]').forEach(b => {
      b.classList.toggle('active', b.dataset.nav === page);
      if (b.dataset.nav === page) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    $('main').innerHTML = loading();

    try {
      if (page === 'dashboard') await dashboard(token);
      else if (page === 'hosts') await hostsPage(token);
      else if (page === 'ssh') { page = 'hosts'; await hostsPage(token); }
      else if (page === 'files') { page = 'hosts'; await hostsPage(token); }
      else if (page === 'k8s') await k8sPage(token);
      else if (page === 'argocd') await argocdPage(token);
      else if (page === 'argowf') await argowfPage(token);
      else if (page === 'settings') await settingsPage(token);
    } catch (e) {
      if (token === generation) $('main').innerHTML = title('错误', 'ERROR', '加载页面时出现问题') + errorHTML(e);
    }
  }

  async function boot() {
    $('refresh').disabled = true;
    try {
      meta = await fetchJSON(API + '/status');
      $('connection').textContent = '已连接';
      $('connection').classList.add('online');
      $('identity').textContent = (meta.toolCount || 0) + ' 个工具';
      await navigate(location.hash.slice(1) || page);
    } catch (e) {
      meta = null;
      $('connection').textContent = '连接失败';
      $('connection').classList.remove('online');
      $('main').innerHTML = errorHTML(e);
    } finally {
      $('refresh').disabled = false;
    }
  }

  // ---- INIT ----
  $('nav').innerHTML = pages.map(([id, icon, label]) =>
    `<button class="nav-item" data-nav="${id}"><span class="nav-icon" aria-hidden="true">${icon}</span>${label}</button>`
  ).join('');

  document.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => navigate(b.dataset.nav));
  $('refresh').onclick = boot;
  $('close-detail').onclick = () => $('detail').close();

  let theme = '';
  try { theme = localStorage.getItem('dshops.theme') || ''; } catch {}
  if (theme) document.documentElement.dataset.theme = theme;
  else if (matchMedia('(prefers-color-scheme:dark)').matches) document.documentElement.dataset.theme = 'dark';

  $('theme').onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('dshops.theme', next); } catch {}
  };

  window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
  void boot();
})();
