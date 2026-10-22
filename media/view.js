// 需求树面板：上面是需求树，下面是选中需求的规则。数据由插件推送，操作发回插件写文件。
// 公共小工具（esc、ago、状态名、遍历树等）来自 detail.js 的 window.ReqDetail，和导图共用。
(function () {
  const vscode = acquireVsCodeApi();
  const D = window.ReqDetail;
  const { esc, STATUS_LABEL, T } = D;
  const saved = vscode.getState() || {};
  let data = null;
  let selected = saved.selected || null;
  let collapsed = new Set(saved.collapsed || []);
  // 树的高度：默认跟着内容走（最多占一半多），详情占剩下的；拖过分隔条就用拖出来的高度
  let treeHeight = saved.treeHeight || null;
  // 只看这一支：树里只留从根到它的路径和它下面的整棵子树（null = 显示全部）
  let focus = saved.focus || null;
  // 跟随 AI：AI 开始改某个需求时，展开它的上级、滚过去、闪一下（默认开）
  let follow = saved.follow !== false;
  // 上级规则超过 3 条时是否展开（整个会话共用一个开关）
  let inheritOpen = !!saved.inheritOpen;
  // 编号（R3.2 这种）默认不显示，设置菜单里能打开
  let showIds = !!saved.showIds;
  // 选中一行后，不在它这一支（上级路径 + 子树）的行稍微变淡；点树的空白处或 Esc 取消（选中不变）
  let dim = !!saved.dim;
  let branch = null;

  const persist = () => vscode.setState({ selected, dim, collapsed: [...collapsed], treeHeight, focus, follow, inheritOpen, showIds });
  const post = msg => vscode.postMessage(msg);
  const ago = t => D.ago(t, data.now || Date.now());

  const app = document.getElementById('app');
  let pending = false;
  window.addEventListener('reqdetail-editend', () => { if (pending) { pending = false; render(); refreshCtx(); } });
  // 上下文用量浮层：开着时数据更新就跟着刷新
  let ctxUri = null;
  const refreshCtx = () => { const f = ctxUri && data.files.find(x => x.uri === ctxUri); if (f) D.refreshContext(f, data.now); };
  function openContext(uri) {
    const f = data.files.find(x => x.uri === uri) || data.files[0];
    ctxUri = f.uri;
    D.showContext(f, { now: data.now, onPick: key => { reveal(key); select(key); } });
  }

  window.addEventListener('message', e => {
    if (e.data.type !== 'data') return;
    data = e.data;
    // 正在面板里改名：先不重画，改完再画（不然输入框会被冲掉）
    if (D.isEditing()) { pending = true; return; }
    render(); refreshCtx(); followAi();
  });

  function allNodes() {
    const out = [];
    (data.files || []).forEach(file => D.walkNodes(file.nodes, n => out.push({ n, file })));
    return out;
  }
  // 聚焦的那棵树和从根到聚焦需求的路径
  function focusPath() {
    if (!focus) return null;
    for (const f of data.files) { const p = D.pathTo(f.nodes, focus); if (p) return { f, p }; }
    return null;
  }

  function render() {
    if (!data.files.length) {
      app.innerHTML = `<div class="welcome">${T('v.noTree')}<br><br><button class="btn" data-act="create">${T('v.create')}</button></div>`;
      return;
    }
    const nodes = allNodes();
    if (!nodes.some(x => x.n.key === selected)) selected = null;
    // 聚焦的需求被删掉了：自动退出「只看这一支」
    const fp = focusPath();
    if (focus && !fp) { focus = null; persist(); }
    const scroll = document.querySelector('.tree')?.scrollTop || 0;
    branch = null;
    if (dim && selected && !fp) {
      const hit = nodes.find(x => x.n.key === selected);
      const p = hit && D.pathTo(hit.file.nodes, selected);
      if (p) { branch = new Set(p.map(n => n.key)); D.walkNodes([hit.n], n => branch.add(n.key)); }
    }

    let html = data.files.map(f => D.alertsHtml(f, data.now)).join('');
    const lastFile = data.files.filter(f => f.recorder && f.recorder.ok).sort((a, b) => b.recorder.time - a.recorder.time)[0];
    const last = lastFile && lastFile.recorder;
    const cfg = data.files[0].config || {};
    const paused = cfg.recorder === 'off';
    html += `<div class="statusbar"><span class="status" title="${T('v.recTip')}">${paused ? T('v.recPaused') : last ? esc(T('v.recLast', ago(last.time), D.recorderText(last, lastFile, showIds))) : T('v.recNever')}</span>
      <button class="follow" data-act="follow" aria-pressed="${follow}" title="${T('v.followTip')}"><span class="fdot" aria-hidden="true"></span>${T('follow')}</button>
      <button class="ibtn mapbtn" data-act="openMap" title="${T('v.mapTip')}">${D.icon('map', 14)}${T('v.map')}</button>
      <button class="ibtn gear" data-act="settings" data-uri="${esc(data.files[0].uri)}" title="${T('v.settings')}" aria-label="${T('v.settings')}">${D.icon('gear', 15)}</button></div>`;
    if (fp) html += focusBar(fp.p);
    html += `<div class="tree" role="tree"${treeHeight && !fp ? ` style="height:${treeHeight}px;max-height:none;flex:none"` : ''}>`;
    if (fp) {
      html += `<ul>${nodeHtml(fp.p[0], fp.f, fp.p)}</ul>`;
    } else {
      for (const f of data.files) {
        if (data.files.length > 1) html += `<div class="gh" style="margin:10px 12px 2px">${esc(f.name)}<span class="line"></span></div>`;
        html += `<ul>${f.nodes.map(n => nodeHtml(n, f)).join('')}</ul>`;
      }
    }
    html += `</div><div class="splitter" title="${T('v.splitter')}"></div>`;
    html += `<div class="detail dp">${detailHtml(nodes)}</div>`;
    app.innerHTML = html;
    app.classList.toggle('app-focus', !!fp);
    document.querySelector('.tree').scrollTop = scroll;
  }

  // 只看这一支时顶部的路径：点上级切换到那一级，「显示全部」退出
  function focusBar(path) {
    const crumbs = path.map((n, i) => i === path.length - 1
      ? `<span class="crumb cur" aria-current="location" title="${esc(n.id + ' ' + n.title)}">${esc(n.title)}</span>`
      : `<button class="crumb" data-act="crumb" data-key="${esc(n.key)}" title="${esc(T('f.crumbTip', n.title))}">${esc(n.title)}</button>`);
    return `<div class="focusbar" role="navigation" aria-label="${T('f.nav')}"><span class="fl">${crumbs.join('<span class="sepr" aria-hidden="true">›</span>')}</span>
      <button class="btn ghost" data-act="unfocus" title="${T('f.exitSide')}">${T('f.showAll')}</button></div>`;
  }


  // path：只看这一支时从根到聚焦需求的路径。路径上的上级只画自己和路径上的下一级，聚焦的需求照常画整棵子树
  function nodeHtml(n, f, path) {
    const onPath = path ? path.indexOf(n) : -1;
    const isAnc = path && onPath >= 0 && onPath < path.length - 1;
    const open = isAnc || !collapsed.has(n.key);
    const shown = isAnc ? [path[onPath + 1]] : n.children;
    const kids = n.children.length;
    const cls = [`d${Math.min(n.depth, 4)}`, n.status || ''].join(' ');
    const U = `data-uri="${esc(f.uri)}"`;
    const meta = [];
    if (n.active) meta.push(`<span class="chip ai" title="${esc(T('ai.editing', n.active.file))}">${D.icon('ai', 12)}<span class="ct">${esc(n.active.file.split('/').pop())}</span></span>`);
    else if (kids && !open && D.hasActive(n)) meta.push(`<span class="chip ai" role="img" title="${T('ai.below')}" aria-label="${T('ai.below')}">${D.icon('ai', 12)}</span>`);
    else if (n.stale) meta.push(`<span class="chip stale" title="${esc(T('stale.tip', data.staleDays))}">${D.icon('stale', 12)}<span class="ct">${T('stale.chip')}</span></span>`);
    const acts = `<span class="acts"><button class="ibtn" data-act="status" title="${T('v.changeStatus')}" aria-label="${T('v.changeStatus')}">${D.icon('status', 13)}</button><button class="ibtn" data-act="open" data-line="${n.line}" data-raw="${esc(n.raw)}" ${U} title="${T('menu.open')}" aria-label="${T('menu.open')}">${D.icon('open', 13)}</button></span>`;
    const rowCls = ['row', n.key === selected ? 'sel' : '', n.active ? 'ai-on' : '', isAnc ? 'anc' : '', branch && !branch.has(n.key) ? 'dim' : ''].filter(Boolean).join(' ');
    return `<li class="${cls}" style="--branch: var(${n.branch})">
      <div class="${rowCls}" tabindex="0" role="treeitem" aria-expanded="${kids ? open : ''}" data-key="${esc(n.key)}" ${U}>
        <span class="twisty${kids ? (open ? ' open' : '') : ' none'}"${isAnc ? '' : ' data-act="toggle"'} aria-hidden="true"></span>
        ${D.dot(n.status)}
        ${showIds ? `<span class="id">${esc(n.id)}</span>` : ''}
        <span class="title" title="${esc(n.title)}${n.status ? ' · ' + STATUS_LABEL[n.status] : ''}">${esc(n.title)}</span>
        <span class="meta">${meta.join('')}${acts}</span>
      </div>
      ${kids && open ? `<ul>${shown.map(c => nodeHtml(c, f, path)).join('')}</ul>` : ''}
    </li>`;
  }

  // 详情用公共组件 detail.js，和导图右侧一模一样
  function detailHtml(nodes) {
    const hit = nodes.find(x => x.n.key === selected);
    return D.html(hit ? hit.file : data.files[0], hit && hit.n, { ...data, inheritOpen, showIds, focusable: true, focusKey: focus, focusLabel: T('d.focusSide') });
  }

  // ---------- 只看这一支 ----------
  function setFocus(key) {
    focus = key;
    if (key) selected = key;
    persist(); render();
    const target = key ? document.querySelector(`.row[data-key="${CSS.escape(key)}"]`) : document.querySelector('.row.sel');
    target?.focus({ preventScroll: !key });
    if (!key) revealRow(selected, false);
  }

  // ---------- 跟随 AI ----------
  // 用户正在操作（输入框有焦点，或 10 秒内点过、按过键、滚过）就不跳，免得抢走用户手上的事
  let lastInteract = 0;
  const touch = () => { lastInteract = Date.now(); };
  document.addEventListener('pointerdown', touch, true);
  document.addEventListener('keydown', touch, true);
  document.addEventListener('wheel', touch, { capture: true, passive: true });
  function userBusy() {
    const a = document.activeElement;
    if (a && a.matches && a.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return true;
    return Date.now() - lastInteract < 10000;
  }
  let prevActive = null; // 上一次数据里 AI 正在改的需求；第一次数据只记下，不跳
  function followAi() {
    if (!data || !data.files.length) return;
    const now = allNodes().filter(x => x.n.active);
    const before = prevActive;
    prevActive = new Set(now.map(x => x.n.key));
    if (!before || !follow || userBusy()) return;
    const fresh = now.filter(x => !before.has(x.n.key)).sort((a, b) => (b.n.active.time || 0) - (a.n.active.time || 0))[0];
    if (!fresh) return;
    const path = D.pathTo(fresh.file.nodes, fresh.n.key);
    // 只看这一支时，AI 改的不在这一支里就不管（不替用户退出聚焦）
    const fp = focusPath();
    if (fp && !path.some(n => n.key === focus)) return;
    let changed = false;
    for (const a of path.slice(0, -1)) if (collapsed.delete(a.key)) changed = true;
    if (changed) { persist(); render(); }
    revealRow(fresh.n.key, true);
  }
  // 把一行滚到树的可见区域中间；flash 时闪一下。减少动态时直接跳过去
  function revealRow(key, flash) {
    const row = key && document.querySelector(`.row[data-key="${CSS.escape(key)}"]`);
    const tree = document.querySelector('.tree');
    if (!row || !tree) return;
    const rr = row.getBoundingClientRect(), tr = tree.getBoundingClientRect();
    if (rr.top < tr.top || rr.bottom > tr.bottom) {
      const top = tree.scrollTop + (rr.top - tr.top) - (tree.clientHeight - rr.height) / 2;
      tree.scrollTo({ top: Math.max(0, top), behavior: D.reducedMotion() ? 'auto' : 'smooth' });
    }
    if (flash) {
      row.classList.add('flash');
      setTimeout(() => row.classList.remove('flash'), 1300);
    }
  }

  // ---------- 交互 ----------
  app.addEventListener('click', e => {
    const actEl = e.target.closest('[data-act]');
    const row = e.target.closest('.row');
    const uri = actEl?.dataset.uri || row?.dataset.uri;
    if (actEl) {
      const act = actEl.dataset.act;
      e.stopPropagation();
      if (act === 'toggle' && row) { toggle(row.dataset.key); return; }
      if (act === 'status' && row) { openMenu(actEl, row.dataset.key, uri); return; }
      if (act === 'settings') { openSettings(actEl, uri); return; }
      if (act === 'follow') { follow = !follow; persist(); actEl.setAttribute('aria-pressed', String(follow)); return; }
      if (act === 'focus' || act === 'crumb') { setFocus(actEl.dataset.key); return; }
      if (act === 'unfocus') { setFocus(null); return; }
      if (act === 'pick') { reveal(actEl.dataset.key); select(actEl.dataset.key); return; }
      const loc = D.local(actEl, post);
      if (loc) { if ('inheritOpen' in loc) { inheritOpen = loc.inheritOpen; persist(); } return; }
      const m = D.message(actEl, uri);
      if (m) { post(m); return; }
      post({ type: act });
      return;
    }
    if (row) {
      // 只看这一支时，上面的路标行就是面包屑：点它改看那一支
      if (row.classList.contains('anc')) setFocus(row.dataset.key);
      else select(row.dataset.key);
      return;
    }
    // 点树里的空白处：退出只看这一支
    if (e.target.closest('.tree')) { if (focus) setFocus(null); else if (dim) { dim = false; persist(); render(); } }
  });

  app.addEventListener('dblclick', e => {
    const row = e.target.closest('.row');
    if (row && !row.classList.contains('anc') && !e.target.closest('[data-act]')) toggle(row.dataset.key);
  });

  // Esc：先关菜单，再退出只看这一支
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (focus) { setFocus(null); e.preventDefault(); } else if (dim) { dim = false; persist(); render(); e.preventDefault(); }
  });

  app.addEventListener('keydown', e => {
    const row = e.target.closest('.row');
    if (!row) return;
    const rows = [...document.querySelectorAll('.row')];
    const i = rows.indexOf(row);
    if (e.key === 'ArrowDown') { rows[i + 1]?.focus(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { rows[i - 1]?.focus(); e.preventDefault(); }
    else if (e.key === 'Enter' || e.key === ' ') { row.classList.contains('anc') ? setFocus(row.dataset.key) : select(row.dataset.key); e.preventDefault(); }
    else if (row.classList.contains('anc')) return;
    else if (e.key === 'ArrowRight' && collapsed.has(row.dataset.key)) toggle(row.dataset.key);
    else if (e.key === 'ArrowLeft' && !collapsed.has(row.dataset.key)) toggle(row.dataset.key);
  });

  // 详情里点子需求：先展开它的上级，树里才看得见
  function reveal(key) {
    for (const f of data.files) {
      const p = D.pathTo(f.nodes, key);
      if (p) { p.slice(0, -1).forEach(a => collapsed.delete(a.key)); break; }
    }
  }
  function select(key) {
    selected = key; dim = true; persist(); render();
    document.querySelector(`.row[data-key="${CSS.escape(key)}"]`)?.focus();
  }
  function toggle(key) {
    collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key);
    persist(); render();
    document.querySelector(`.row[data-key="${CSS.escape(key)}"]`)?.focus();
  }

  // 浮动菜单用 detail.js 的 D.showMenu（和详情里的 ⋯ 菜单同一种样式）
  // 状态菜单：和详情面板的状态按钮走同一条路（按需求 ID 改、记进改动记录、能撤销）
  function openMenu(anchor, key, uri) {
    const n = allNodes().find(x => x.n.key === key).n;
    D.showMenu(anchor, [...D.STATUS_ORDER.map(s => ({ html: D.dot(s, false) + STATUS_LABEL[s], data: { s }, checked: n.status === s, run: () => post({ type: 'edit', action: 'setStatus', uri, node: n.id, status: s }) })),
      { label: T('v.clearStatus'), data: { s: '' }, run: () => post({ type: 'edit', action: 'setStatus', uri, node: n.id, status: '' }) }], { label: T('d.status'), cls: 'st-menu' });
  }

  // 设置菜单：只放真正需要用户取舍的开关。记下的要求一律直接生效，记错了在「最近改动」里撤销
  function openSettings(anchor, uri) {
    const cfg = data.files.find(f => f.uri === uri)?.config || {};
    D.showMenu(anchor, [
      ['turn', T('v.recTurn'), cfg.recorder !== 'off'],
      ['off', T('v.recOff'), cfg.recorder === 'off'],
    ].map(([v, label, on]) => ({ label, checked: on, radio: true, data: { v }, run: () => post({ type: 'setConfig', uri, patch: { recorder: v } }) }))
      .concat([{ label: T('showIds'), checked: showIds, toggle: true, run: () => { showIds = !showIds; persist(); render(); } },
        { label: T('ctx.menu'), run: () => openContext(uri) }]));
  }

  // 拖动分隔条调整树的高度（详情占剩下的）
  app.addEventListener('pointerdown', e => {
    if (!e.target.classList.contains('splitter')) return;
    const tree = document.querySelector('.tree');
    const startY = e.clientY, startH = tree.offsetHeight;
    const move = ev => {
      treeHeight = Math.max(80, Math.min(innerHeight - 160, startH + (ev.clientY - startY)));
      Object.assign(tree.style, { height: treeHeight + 'px', maxHeight: 'none', flex: 'none' });
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); persist(); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });

  post({ type: 'ready' });
})();
