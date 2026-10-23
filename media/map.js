// 需求树导图：编辑区里的大视图。横向树，节点是卡片；滚轮缩放、拖动画布、点卡片聚焦这一支、点右边的圆圈折叠子需求。
// 数据和侧栏同一份（viewmodel），操作也发回同一个处理函数；公共小工具来自 detail.js 的 window.ReqDetail。
// 导图只画第一棵树（data.files[0]），概况、查找、全部展开等也只看这一棵，数字才和画面对得上。
(function () {
  const vscode = acquireVsCodeApi();
  const D = window.ReqDetail;
  const { esc, STATUS_LABEL, T } = D;
  const saved = vscode.getState() || {};
  let data = null;
  let selected = saved.selected || null;
  let collapsed = new Set(saved.collapsed || []); // 子需求折叠起来的卡片（右边的圆圈）
  let view = saved.view || null; // { x, y, k } 画布平移和缩放；数据到达、第一次排版后才有
  // 卡片展开（标题行下面列出说明和规则）：工具栏的「只看标题 | 显示规则」定默认（defaultOpen），
  // 用户点过某张卡片的「› 2 条」，那张卡片就按自己的来（cardOpen：key → true/false），不跟着默认变
  let defaultOpen = !!saved.defaultOpen;
  let cardOpen = new Map(Object.entries(saved.cardOpen || {}));
  // 选中一张卡片时，不在它这一支（上级路径 + 子树）的卡片和连线变淡；点空白处或 Esc 取消变淡（选中不变）
  let dim = !!saved.dim;
  // 聚焦：点一张卡片，只留从根到它的路径和它下面的整棵子树，镜头放大到这一支。
  // 聚焦时这一支的卡片默认展开（自己点过的照旧）
  let focus = saved.focus || null;
  // 跟随 AI：AI 开始改某个需求时，把它的卡片平移到视野里、闪一下（默认开）
  let follow = saved.follow !== false;
  let hideDone = !!saved.hideDone; // 隐藏已完成的需求（和它下面的）
  let inheritOpen = !!saved.inheritOpen;
  // 编号（R3.2 这种）默认不显示，⋯ 菜单里能打开
  let showIds = !!saved.showIds;
  const persist = () => vscode.setState({ selected, dim, collapsed: [...collapsed], view, defaultOpen, cardOpen: Object.fromEntries(cardOpen), focus, follow, hideDone, inheritOpen, showIds });
  const post = msg => vscode.postMessage(msg);

  // 布局：卡片宽、标题行高、层间距、兄弟间距、规则最多列几条
  const W = 248, H_TITLE = 40, GAP_X = 72, GAP_Y = 16;
  const MAX_RULES = 6;
  const MIN_FIT = 0.85; // 自动适应窗口时最小的缩放，再小字就看不清了

  // 页面骨架（map-body.js）上的文字按语言填：data-t 文字（有 data-t-short 就再放一份窄屏用的短文字）、data-t-title 提示、data-t-aria 读屏名字
  for (const el of document.querySelectorAll('[data-t]')) {
    const short = el.dataset.tShort;
    el.innerHTML = short ? `<span class="lg">${esc(T(el.dataset.t))}</span><span class="sh">${esc(T(short))}</span>` : esc(T(el.dataset.t));
  }
  for (const el of document.querySelectorAll('[data-t-title]')) el.title = T(el.dataset.tTitle);
  for (const el of document.querySelectorAll('[data-t-aria]')) el.setAttribute('aria-label', T(el.dataset.tAria));

  const svg = document.getElementById('canvas');
  const world = document.getElementById('world');
  const side = document.getElementById('side');

  // 正在面板里改名：先不重画，改完再画（不然输入框会被冲掉）
  let pending = false;
  window.addEventListener('message', e => {
    if (e.data.type !== 'data') return;
    data = e.data;
    if (D.isEditing()) { pending = true; return; }
    render(); if (data.files.length) D.refreshContext(file(), data.now); followAi();
  });
  window.addEventListener('reqdetail-editend', () => { if (pending) { pending = false; render(); } });
  const file = () => data.files[0];

  // SVG 不会自动省略，文字宽度只能估算。标签的宽度和截断都用这一个估算，免得量的和截的不一样。
  // 系数按 Edge 里 Segoe UI / 微软雅黑实测（字母 0.46–0.50em、数字 0.54–0.58em、汉字 1em），略往宽估：多出的是留白，少了就被截断。
  function textWidth(s, px) {
    let w = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      w += px * (c === 0x20 ? 0.3 : c < 0x300 ? 0.58 : 1); // 空格 / 西文 / 中文和其他符号
    }
    return w;
  }
  function fit(text, max, px) {
    max += 0.01; // 宽度是小数，加回去再减会有舍入误差，别因此把刚好放得下的截掉
    if (textWidth(text, px) <= max) return text;
    let out = '';
    for (const ch of text) {
      if (textWidth(out + ch + '…', px) > max) return out + '…';
      out += ch;
    }
    return out;
  }
  // 折成最多两行，第二行还放不下再省略
  function wrap2(text, max, px) {
    const chars = [...text];
    let i = 0, w = 0;
    while (i < chars.length && w + textWidth(chars[i], px) <= max) { w += textWidth(chars[i], px); i++; }
    if (i >= chars.length) return [text];
    // 别把一个英文单词从中间断开：退回到这一行里最后一个空格
    const latin = c => /[A-Za-z0-9]/.test(c || '');
    if (latin(chars[i - 1]) && latin(chars[i])) { const sp = chars.lastIndexOf(' ', i - 1); if (sp > 0) i = sp; }
    return [chars.slice(0, i).join(''), fit(chars.slice(i).join('').trimStart(), max, px)];
  }

  // ---------- 布局：经典分层树，叶子从上到下排，父节点居中于子节点 ----------
  const shownKids = n => (collapsed.has(n.key) ? [] : hideDone ? n.children.filter(c => c.status !== 'done') : n.children);
  function layout(roots) {
    const out = [];
    let y = 0;
    const place = (n, depth) => {
      const kids = shownKids(n);
      const item = { n, depth, x: (depth - 1) * (W + GAP_X), kids: [], h: cardHeight(n) };
      const start = y;
      if (!kids.length) { item.y = y; y += item.h + GAP_Y; }
      else {
        item.kids = kids.map(c => place(c, depth + 1));
        // 父卡片的标题行对齐到子卡片标题行的中间；卡片比子树高时往下让，不和别的卡片重叠
        item.y = Math.max(start, (item.kids[0].y + item.kids[item.kids.length - 1].y) / 2);
        y = Math.max(y, item.y + item.h + GAP_Y);
      }
      out.push(item);
      return item;
    };
    roots.forEach(r => { place(r, 1); y += GAP_Y * 2; });
    return out;
  }

  // ---------- 卡片 ----------
  // 收起：只有标题行（状态点、编号、标题、规则条数）。展开：下面再列进度、AI 在改的文件、规则（12px，最多折两行）
  const ownRules = n => (n.groups.find(g => g.self) || { rules: [] }).rules;
  // 这张卡片展开没有：自己点过的按自己的；聚焦时这一支默认展开；否则按工具栏的默认
  function isOpen(n) {
    if (cardOpen.has(n.key)) return cardOpen.get(n.key);
    if (focus && inFocus(n.key)) return true;
    return defaultOpen;
  }
  let focusSub = null; // 每次排版前算好：聚焦这一支的 key 集合
  const inFocus = key => !!(focusSub && focusSub.has(key));
  const RULE_PX = 12, RULE_LH = 18, RULE_GAP = 7, PAD = 12;
  const ruleBlocks = n => ownRules(n).slice(0, MAX_RULES).map(r => wrap2(r.text, W - PAD * 2 - (r.state === 'overrides' ? 0 : 0), RULE_PX));
  const aiText = n => (n.active ? T('ai.editing', n.active.file.split('/').pop()) : '');
  const metaText = n => (n.children.length ? T('m.progress', n.children.filter(c => c.status === 'done').length, n.children.length) : '');
  const hasMeta = n => !!(metaText(n) || n.active);
  function cardHeight(n) {
    if (!isOpen(n)) return H_TITLE;
    let h = H_TITLE;
    if (hasMeta(n)) h += 20;
    const rules = ownRules(n);
    if (rules.length) {
      const blocks = ruleBlocks(n);
      h += 10 + blocks.reduce((k, b) => k + b.length * RULE_LH, 0) + (blocks.length - 1) * RULE_GAP + (rules.length > MAX_RULES ? RULE_LH : 0);
    }
    return h + (h > H_TITLE ? 10 : 0);
  }
  function cardBody(n, x, y) {
    if (!isOpen(n)) return '';
    let s = '', ty = y + H_TITLE;
    if (hasMeta(n)) {
      const meta = metaText(n), ai = aiText(n);
      s += meta ? `<text class="cmeta" x="${x + PAD}" y="${ty + 12}">${esc(meta)}</text>` : '';
      if (ai) {
        const left = x + PAD + (meta ? textWidth(meta, 11) + 12 : 0);
        s += `<text class="cai-t" x="${left}" y="${ty + 12}"><title>${esc(T('ai.editing', n.active.file))}</title>${esc(fit(ai, x + W - PAD - left, 11))}</text>`;
      }
      ty += 20;
    }
    const rules = ownRules(n);
    if (rules.length) {
      s += `<line class="sep" x1="${x + PAD}" x2="${x + W - PAD}" y1="${ty + 2}" y2="${ty + 2}"/>`;
      ty += 10 + 13;
      ruleBlocks(n).forEach((block, i) => {
        const r = rules[i];
        const tip = r.state === 'overrides' ? T('m.overTip', r.text, r.ref) : r.text;
        s += `<text class="rl rl-${r.state}" x="${x + PAD}" y="${ty}"><title>${esc(tip)}</title>${block.map((line, j) => `<tspan x="${x + PAD}"${j ? ` dy="${RULE_LH}"` : ''}>${esc(line)}</tspan>`).join('')}</text>`;
        ty += block.length * RULE_LH + RULE_GAP;
      });
      if (rules.length > MAX_RULES) s += `<text class="rl more" x="${x + PAD}" y="${ty}">${esc(T('m.moreRules', rules.length - MAX_RULES))}</text>`;
    }
    return s;
  }

  // 状态点，单色：进行中是强调色实心点，待做是灰色空心圈，完成是灰色勾，待定是灰色圈里的问号
  function statusDot(s, cx, cy) {
    if (s === 'done') return `<path class="st-tick" d="M${cx - 4.5} ${cy + 0.2} l3 3.1 l6 -6.4"/>`;
    if (s === 'doing') return `<circle class="st-doing-ring" cx="${cx}" cy="${cy}" r="6"/><circle class="st-doing" cx="${cx}" cy="${cy}" r="3.5"/>`;
    if (s === 'question') return `<circle class="st-q" cx="${cx}" cy="${cy}" r="6"/><text class="st-qm" x="${cx}" y="${cy + 3.3}">?</text>`;
    if (s === 'todo') return `<circle class="st-todo" cx="${cx}" cy="${cy}" r="5.5"/>`;
    return `<circle class="st-none" cx="${cx}" cy="${cy}" r="2.5"/>`;
  }

  // 标题行右边的小标签：11px 字、16px 高；图标 11px，和文字隔 3px
  const TAG_PX = 11, ICO = 11, ICO_GAP = 3;
  function iconText(name, text, x, y, w) {
    const tw = text ? textWidth(text, TAG_PX) : 0;
    const total = ICO + (text ? ICO_GAP + tw : 0);
    const left = x + (w - total) / 2;
    return D.icon(name, ICO, `x="${left.toFixed(1)}" y="${y + 2.5}"`) +
      (text ? `<text class="lt" x="${(left + ICO + ICO_GAP).toFixed(1)}" y="${y + 12}">${esc(text)}</text>` : '');
  }
  // 估算的文字宽度故意偏宽（宁可留白不截断），画出来后按实际宽度把「图标 + 文字」重新居中，左右留白才一样
  function recenterTags() {
    for (const g of world.querySelectorAll('.badge, .rchip')) {
      const box = g.querySelector(':scope > rect'), ic = g.querySelector(':scope > svg.ico'), t = g.querySelector(':scope > text');
      if (!box || !ic || !t) continue;
      const len = t.getComputedTextLength(); // 页面没显示时量出来是 0，那就保持估算的位置
      if (!len || !isFinite(len)) continue;
      const real = ICO + ICO_GAP + len;
      const left = +box.getAttribute('x') + (+box.getAttribute('width') - real) / 2;
      ic.setAttribute('x', left.toFixed(1));
      t.setAttribute('x', (left + ICO + ICO_GAP).toFixed(1));
    }
  }
  // 展开 / 收起这张卡片：「› 2 条」，箭头朝下表示已展开。没有规则也能展开（看进度和 AI 在改的文件）
  const chipLabel = n => (n.ruleCount ? T('m.count', n.ruleCount) : '');
  const chipWidth = n => ICO + (n.ruleCount ? ICO_GAP + textWidth(chipLabel(n), TAG_PX) : 0) + 10;
  function rulesChip(n, x, y) {
    const w = chipWidth(n), on = isOpen(n);
    const label = esc(T('m.cardToggle', on, n.ruleCount));
    return `<g class="rchip${on ? ' on' : ''}" data-rules="${esc(n.key)}" role="button" tabindex="0" aria-expanded="${on}" aria-label="${label}"><title>${label}</title><rect x="${x}" y="${y}" width="${w}" height="16"/>${iconText(on ? 'chevd' : 'chev', chipLabel(n), x, y, w)}</g>`;
  }
  // 徽章（只有图标）：AI 正在改用强调色；久未动是灰色月亮
  function badge(cls, ic, x, y, tip) {
    return `<g class="badge ${cls}"><title>${esc(tip)}</title><rect x="${x}" y="${y}" width="22" height="16"/>${iconText(ic, '', x, y, 22)}</g>`;
  }
  // 上两层（根和第一层）的标题行有底色：只圆上面两个角；卡片收起时整张卡就是标题行
  let rCard = null;
  const R_CARD = () => rCard ?? (rCard = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--r-card')) || 6);
  function bandPath(x, y, h) {
    const r = R_CARD();
    if (h <= H_TITLE) return `M${x + r} ${y}H${x + W - r}a${r} ${r} 0 0 1 ${r} ${r}V${y + h - r}a${r} ${r} 0 0 1 ${-r} ${r}H${x + r}a${r} ${r} 0 0 1 ${-r} ${-r}V${y + r}a${r} ${r} 0 0 1 ${r} ${-r}Z`;
    return `M${x} ${y + H_TITLE}V${y + r}a${r} ${r} 0 0 1 ${r} ${-r}H${x + W - r}a${r} ${r} 0 0 1 ${r} ${r}V${y + H_TITLE}Z`;
  }

  // 顶部概况：每种状态各有几项（和卡片上同样的圆点）
  function renderSummary() {
    const all = [];
    D.walkNodes(file().nodes, n => all.push(n));
    const c = s => all.filter(n => n.status === s).length;
    const active = all.filter(n => n.active).length;
    document.getElementById('summary').innerHTML =
      ['doing', 'question', 'todo', 'done'].map(s => `<span class="sum">${D.dot(s)}${STATUS_LABEL[s]} <b>${c(s)}</b></span>`).join('') +
      (active ? `<span class="sum ai">${D.icon('ai', 13)}${T('ai.sum')} <b>${active}</b></span>` : '');
  }
  // 工具栏的按下状态：只看标题 / 显示规则、隐藏已完成、跟随 AI、缩放百分比
  function renderToolbar() {
    const all = [];
    if (data && data.files.length) D.walkNodes(file().nodes, n => all.push(n.key));
    const set = (act, on) => document.querySelector(`.toolbar [data-act="${act}"]`)?.setAttribute('aria-pressed', String(on));
    set('compactAll', !defaultOpen);
    set('rulesAll', defaultOpen);
    set('hideDone', hideDone);
    set('follow', follow);
  }

  function render() {
    renderToolbar();
    if (!data || !data.files.length) {
      world.innerHTML = '';
      side.innerHTML = `<div class="empty">${T('m.noTree')}</div>`;
      return;
    }
    const f = file();
    // 聚焦的需求被删了，或被折叠的上级、「隐藏已完成」藏起来了：自动退出聚焦
    if (focus && !findNode(focus)) exitFocusState();
    focusSub = focusSets()?.sub || null;
    let items = layout(f.nodes);
    if (focus && !items.some(i => i.n.key === focus)) { exitFocusState(); focusSub = null; items = layout(f.nodes); }
    lastItems = items;
    const fset = focusSets();
    // 选中后变淡：不在选中这一支的卡片和连线（聚焦模式下不用，那边已经隐藏了别的）
    const branch = dim && !fset && selected ? branchOf(selected) : null;
    const dcls = key => (branch && !branch.has(key) ? ' dim' : '');
    const fcls = key => !fset ? '' : fset.sub.has(key) ? ' f-in' : fset.anc.has(key) ? ' f-anc' : ' f-out';
    let links = '', cards = '';
    for (const it of items) {
      const ty = it.y + H_TITLE / 2; // 标题行中线：连线、圆点、子需求开关都对齐到这里
      for (const k of it.kids) {
        const x1 = it.x + W, x2 = k.x, y2 = k.y + H_TITLE / 2, mx = (x1 + x2) / 2;
        const lc = !fset ? '' : fset.sub.has(k.n.key) ? '' : fset.anc.has(k.n.key) ? ' f-anc' : ' f-out';
        links += `<path class="link${k.n.status === 'done' ? ' l-done' : ''}${lc}${branch && !(branch.has(k.n.key) && branch.has(n0(it))) ? ' dim' : ''}" d="M${x1} ${ty} C${mx} ${ty} ${mx} ${y2} ${x2} ${y2}"/>`;
      }
      const n = it.n;
      const kidsHidden = collapsed.has(n.key) && n.children.length;
      const depth = Math.min(it.depth, 4);
      const titlePx = depth === 1 ? 16 : depth === 2 ? 14 : 13;
      const idW = showIds ? textWidth(n.id, 11) + 8 : 0;
      // 标题行右边从右往左：展开开关、AI 徽章、久未动
      let rx = it.x + W - 14;
      const tagY = ty - 8;
      const cw = chipWidth(n);
      rx -= cw;
      let tags = rulesChip(n, rx, tagY);
      const aiTip = n.active ? T('ai.editing', n.active.file) : kidsHidden && D.hasActive(n) ? T('ai.below') : '';
      if (aiTip) { rx -= 26; tags += badge('ai', 'ai', rx, tagY, aiTip); }
      if (n.stale) { rx -= 26; tags += badge('stale', 'stale', rx, tagY, T('stale.mapTip', data.staleDays)); }
      const titleX = it.x + 30 + idW;
      const title = fit(n.title, rx - 6 - titleX, titlePx);
      const cls = ['card', `d${depth}`, n.status || '', isOpen(n) ? 'open' : '', n.key === selected ? 'sel' : '', n.active ? 'ai-on' : ''].filter(Boolean).join(' ');
      cards += `<g class="${cls}${fcls(n.key)}${dcls(n.key)}" style="--branch: var(${n.branch})" data-key="${esc(n.key)}" tabindex="0" role="button" aria-label="${esc(n.id + ' ' + n.title + (n.status ? '，' + STATUS_LABEL[n.status] : ''))}">
        ${n.active ? `<rect class="halo" x="${it.x - 3}" y="${it.y - 3}" width="${W + 6}" height="${it.h + 6}"/>` : ''}
        <rect class="box" x="${it.x}" y="${it.y}" width="${W}" height="${it.h}"/>
        ${depth <= 2 ? `<path class="band" d="${bandPath(it.x, it.y, it.h)}"/>` : ''}
        ${statusDot(n.status, it.x + 17, ty)}
        ${showIds ? `<text class="cid" x="${it.x + 30}" y="${ty + 4}">${esc(n.id)}</text>` : ''}
        <text class="ctitle" x="${titleX}" y="${ty + titlePx * 0.36}">${esc(title)}</text>
        ${tags}
        ${cardBody(n, it.x, it.y)}
        ${n.children.length ? `<g class="toggle" data-toggle="${esc(n.key)}" role="button" aria-label="${kidsHidden ? T('m.kidsShow', n.children.length) : T('m.kidsHide')}"><title>${kidsHidden ? T('m.kidsShow', n.children.length) : T('m.kidsHide')}</title><circle cx="${it.x + W}" cy="${ty}" r="9"/>${kidsHidden ? `<text x="${it.x + W}" y="${ty + 4}">${n.children.length}</text>` : `<path d="M${it.x + W - 3.5} ${ty}h7"/>`}</g>` : ''}
        <title>${esc(n.id + ' ' + n.title)}</title>
      </g>`;
    }
    world.innerHTML = `<g class="links">${links}</g><g class="cards">${cards}</g>`;
    recenterTags();
    if (!view) view = fitTarget(items);
    applyView();
    const selNode = selected && findNode(selected);
    side.innerHTML = D.html(f, selNode, { ...data, inheritOpen, showIds, focusable: true, focusKey: focus, focusLabel: T('d.focusMap') });
    side.classList.toggle('none', !selNode); // 窄的时候详情在下面，没选中就收成一行
    document.getElementById('alerts').innerHTML = D.alertsHtml(f, data.now);
    renderSummary();
    renderFocusBar();
  }

  // ---------- 聚焦 ----------
  let lastItems = [];
  // 聚焦时：sub = 它和它下面的需求，anc = 从根到它的上级
  function focusSets() {
    if (!focus) return null;
    const path = D.pathTo(file().nodes, focus);
    if (!path) return null;
    const sub = new Set();
    D.walkNodes([path[path.length - 1]], n => sub.add(n.key));
    return { sub, anc: new Set(path.slice(0, -1).map(n => n.key)), path };
  }
  function exitFocusState() { focus = null; }
  // 选中的这一支：从根到它的路径 + 它的整棵子树
  const n0 = it => it.n.key;
  function branchOf(key) {
    const path = D.pathTo(file().nodes, key);
    if (!path) return null;
    const set = new Set(path.map(n => n.key));
    D.walkNodes([path[path.length - 1]], n => set.add(n.key));
    return set;
  }
  // 点卡片：选中、别的分支变淡（不缩放、不隐藏）
  function select(key) { selected = key; dim = true; persist(); render(); }
  function undim() { dim = false; persist(); render(); }
  function setFocus(key) {
    if (key) {
      focus = key; selected = key;
      collapsed.delete(key);
    } else exitFocusState();
    dim = false;
    persist(); render();
    animateTo(fitTarget(lastItems));
  }
  // 顶部路径：点上级改看那一级，「显示全部」退出
  function renderFocusBar() {
    const bar = document.getElementById('focusbar');
    if (!bar) return;
    const fset = focusSets();
    if (!fset) { bar.hidden = true; bar.innerHTML = ''; return; }
    bar.hidden = false;
    const p = fset.path;
    bar.innerHTML = `<span class="fl">${p.map((n, i) => i === p.length - 1
      ? `<span class="crumb cur" aria-current="location" title="${esc(n.id)}">${esc(n.title)}</span>`
      : `<button class="crumb" data-act="crumb" data-key="${esc(n.key)}" title="${esc(T('f.crumbTip', n.title))}">${esc(n.title)}</button>`).join('<span class="sepr" aria-hidden="true">›</span>')}</span>
      <button class="btn ghost" data-act="unfocus" title="${T('f.exitMap')}">${T('f.showAll')}</button>`;
  }

  function findNode(key) {
    let hit = null;
    D.walkNodes(file().nodes, n => { if (n.key === key) hit = n; });
    return hit;
  }

  // ---------- 平移缩放 ----------
  // 数据到达之前 view 还是 null，这时的滚轮、缩放、拖动都直接忽略
  // 画布的点阵底纹跟着平移缩放走；工具栏里显示缩放百分比
  function applyView() {
    if (!view) return;
    world.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
    svg.style.backgroundPosition = `${view.x}px ${view.y}px`;
    svg.style.backgroundSize = `${24 * view.k}px ${24 * view.k}px`;
    const pct = document.querySelector('.toolbar [data-act="fit"]');
    if (pct) pct.textContent = Math.round(view.k * 100) + '%';
  }
  // 适应窗口：没聚焦时看整棵树，放大填满画布、居中（最大 1.4 倍）；聚焦时只看这一支，放大到好读，最大 1.5 倍
  function fitTarget(items) {
    const r = svg.getBoundingClientRect();
    const fset = focusSets();
    const shown = fset ? items.filter(i => fset.sub.has(i.n.key)) : items;
    if (!shown.length) return view || { k: 1, x: 20, y: 20 };
    if (!fset) {
      const x0 = Math.min(...items.map(i => i.x)), y0 = Math.min(...items.map(i => i.y));
      const tw = Math.max(...items.map(i => i.x + W)) - x0 + 12, th = Math.max(...items.map(i => i.y + i.h)) - y0;
      // 字不能小到看不清：自动适应最小 0.85 倍；放不下就靠左、可以拖着看（手动缩小不受这个限制）
      const k = Math.max(MIN_FIT, Math.min(1.4, (r.width - 64) / tw, (r.height - 64) / th));
      return { k, x: tw * k <= r.width - 32 ? (r.width - tw * k) / 2 - x0 * k : 24 - x0 * k, y: Math.max(16, (r.height - th * k) / 2) - y0 * k };
    }
    const M = 48;
    const x0 = Math.min(...shown.map(i => i.x)) - 12, y0 = Math.min(...shown.map(i => i.y)) - 12;
    const x1 = Math.max(...shown.map(i => i.x + W)) + 12, y1 = Math.max(...shown.map(i => i.y + i.h)) + 12;
    const k = Math.max(MIN_FIT, Math.min(1.5, (r.width - M * 2) / (x1 - x0), (r.height - M * 2) / (y1 - y0)));
    const w = (x1 - x0) * k, h = (y1 - y0) * k;
    return { k, x: w <= r.width - 32 ? (r.width - w) / 2 - x0 * k : 24 - x0 * k, y: Math.max(16, (r.height - h) / 2) - y0 * k };
  }
  // 镜头平滑移过去；减少动态时直接跳。用户一滚轮、一拖动、一点缩放就停下
  let anim = 0;
  function stopAnim() { if (anim) cancelAnimationFrame(anim); anim = 0; }
  function animateTo(target) {
    stopAnim();
    if (!view || D.reducedMotion()) { view = target; applyView(); persist(); return; }
    const from = view, t0 = performance.now(), DUR = 450;
    const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    const step = now => {
      const t = Math.min(1, (now - t0) / DUR), e = ease(t);
      view = { k: from.k + (target.k - from.k) * e, x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e };
      applyView();
      if (t < 1) anim = requestAnimationFrame(step); else { anim = 0; persist(); }
    };
    anim = requestAnimationFrame(step);
  }
  // 按钮缩放以画布中心为准
  function zoom(k) {
    stopAnim();
    const r = svg.getBoundingClientRect(), cx = r.width / 2, cy = r.height / 2;
    k = Math.max(0.25, Math.min(2.5, k));
    view = { k, x: cx - (cx - view.x) * (k / view.k), y: cy - (cy - view.y) * (k / view.k) };
  }
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    if (!view) return;
    stopAnim();
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const k = Math.max(0.25, Math.min(2.5, view.k * Math.exp(-e.deltaY * 0.0015)));
    view = { k, x: px - (px - view.x) * (k / view.k), y: py - (py - view.y) * (k / view.k) };
    applyView(); persist();
  }, { passive: false });
  let drag = null;
  svg.addEventListener('pointerdown', e => {
    if (!view || e.target.closest('.card')) return;
    stopAnim();
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('dragging');
  });
  svg.addEventListener('pointermove', e => {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) drag.moved = true;
    view = { ...view, x: drag.vx + e.clientX - drag.x, y: drag.vy + e.clientY - drag.y };
    applyView();
  });
  let justDragged = false; // 拖完画布松手也会触发 click，不能当成「点空白处退出聚焦」
  svg.addEventListener('pointerup', () => { if (drag) { justDragged = drag.moved; drag = null; persist(); svg.classList.remove('dragging'); } });

  // ---------- 点击 ----------
  svg.addEventListener('click', e => {
    const t = e.target.closest('[data-toggle]');
    if (t) { const k = t.dataset.toggle; collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k); persist(); render(); return; }
    const rc = e.target.closest('[data-rules]');
    if (rc) { toggleCard(rc.dataset.rules); return; }
    const card = e.target.closest('.card');
    if (card) { if (focus && !inFocus(card.dataset.key)) setFocus(card.dataset.key); else select(card.dataset.key); return; }
    const dragged = justDragged; justDragged = false;
    if (dragged || !data) return;
    if (focus) setFocus(null); else if (dim) undim();
  });
  // 双击卡片：聚焦这一支（隐藏别的、放大）
  svg.addEventListener('dblclick', e => {
    const card = e.target.closest('.card');
    if (card && !e.target.closest('[data-toggle], [data-rules]')) setFocus(card.dataset.key);
  });
  // 一张卡片自己的展开 / 收起，和工具栏的默认无关
  function toggleCard(k) {
    const n = findNode(k);
    if (!n) return;
    cardOpen.set(k, !isOpen(n));
    persist(); render();
    world.querySelector(`.rchip[data-rules="${CSS.escape(k)}"]`)?.focus();
  }
  svg.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const rc = e.target.closest('[data-rules]');
    if (rc) { toggleCard(rc.dataset.rules); e.preventDefault(); e.stopPropagation(); return; }
    const card = e.target.closest('.card');
    if (card) { const k = card.dataset.key; select(k); world.querySelector(`.card[data-key="${CSS.escape(k)}"]`)?.focus(); e.preventDefault(); }
  });
  // Esc：先退出聚焦，再取消变淡
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !data) return;
    if (focus) { setFocus(null); e.preventDefault(); } else if (dim) { undim(); e.preventDefault(); }
  });
  // 工具栏里改树形的按钮：数据没到时什么也不做
  const TREE_ACTS = {
    compactAll: () => { defaultOpen = false; }, // 只看标题（自己点过的卡片照旧）
    rulesAll: () => { defaultOpen = true; }, // 显示规则
    rulesNone: () => { defaultOpen = false; },
    hideDone: () => { hideDone = !hideDone; },
    expandAll: () => collapsed.clear(),
    collapseDone: () => D.walkNodes(file().nodes, n => { if (n.status === 'done' && n.children.length) collapsed.add(n.key); }),
  };
  document.body.addEventListener('click', e => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const act = a.dataset.act;
    if (act === 'fit') { if (data && data.files.length) animateTo(fitTarget(lastItems)); return; }
    if (act === 'follow') { follow = !follow; a.setAttribute('aria-pressed', String(follow)); persist(); return; }
    if (act === 'crumb' || act === 'focus') { if (data) setFocus(a.dataset.key); return; }
    if (act === 'pick') { if (data) select(a.dataset.key); return; }
    if (act === 'unfocus') { if (data) setFocus(null); return; }
    if (act === 'mapMore') {
      D.showMenu(a, [
        { label: T('m.expandAll'), run: () => runTree('expandAll') },
        { label: T('showIds'), checked: showIds, toggle: true, run: () => { showIds = !showIds; persist(); if (data) render(); } },
        { label: T('ctx.menu'), run: () => { if (data && data.files.length) D.showContext(file(), { now: data.now, onPick: select }); } },
        { label: T('m.collapseDone'), run: () => runTree('collapseDone') },
      ]);
      return;
    }
    const loc = D.local(a, post);
    if (loc) { if ('inheritOpen' in loc) { inheritOpen = loc.inheritOpen; persist(); } return; }
    if (act === 'zoomIn' || act === 'zoomOut') { if (view) { zoom(view.k * (act === 'zoomIn' ? 1.2 : 1 / 1.2)); applyView(); persist(); } return; }
    if (TREE_ACTS[act]) { runTree(act); return; }
    const m = D.message(a);
    if (m) return post(m);
    post({ type: act });
  });
  function runTree(act) { if (data && data.files.length) { TREE_ACTS[act](); persist(); render(); } else if (act === 'hideDone' || act === 'compactAll' || act === 'rulesAll') { TREE_ACTS[act](); persist(); renderToolbar(); } }
  window.addEventListener('resize', applyView);
  renderToolbar();

  // ---------- 跟随 AI ----------
  // 用户正在操作（输入框有焦点，或 10 秒内点过、按过键、滚过）就不动镜头
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
  let prevActive = null; // 第一次数据只记下，不动
  function followAi() {
    if (!data || !data.files.length) return;
    const now = [];
    D.walkNodes(file().nodes, n => { if (n.active) now.push(n); });
    const before = prevActive;
    prevActive = new Set(now.map(n => n.key));
    if (!before || !follow || userBusy()) return;
    const fresh = now.filter(n => !before.has(n.key)).sort((a, b) => (b.active.time || 0) - (a.active.time || 0))[0];
    if (!fresh) return;
    const path = D.pathTo(file().nodes, fresh.key);
    if (focus && !path.some(n => n.key === focus)) return; // 聚焦在别的分支：不替用户退出
    let changed = false;
    for (const a of path.slice(0, -1)) if (collapsed.delete(a.key)) changed = true;
    if (changed) { persist(); render(); }
    const it = lastItems.find(i => i.n.key === fresh.key);
    if (!it || !view) return;
    const r = svg.getBoundingClientRect();
    const sx = it.x * view.k + view.x, sy = it.y * view.k + view.y;
    const inView = sx >= 0 && sy >= 0 && sx + W * view.k <= r.width && sy + it.h * view.k <= r.height;
    if (!inView) animateTo({ k: view.k, x: r.width / 2 - (it.x + W / 2) * view.k, y: r.height / 2 - (it.y + it.h / 2) * view.k });
    const g = world.querySelector(`.card[data-key="${CSS.escape(fresh.key)}"]`);
    if (g) { g.classList.add('flash'); setTimeout(() => g.classList.remove('flash'), 1300); }
  }

  post({ type: 'ready' });
})();
