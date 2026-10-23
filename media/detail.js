// 需求详情面板：侧栏和导图共用同一份，两边永远一致。
// 只负责生成 HTML；点击由各自页面统一转成消息发给插件（见 ReqDetail.message）。
// 两边都要用的小工具也放这里（本文件在 view.js / map.js 之前加载），免得各写一份、慢慢写得不一样。
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // 界面文字：语言由插件写在 <body data-lang> 上（zh / en），文字表在 strings.js
  const T = window.ReqStrings ? window.ReqStrings.make(document.body && document.body.dataset.lang) : k => k;
  const STATUS_LABEL = { todo: T('st.todo'), doing: T('st.doing'), done: T('st.done'), question: T('st.question') };
  // 状态菜单里的顺序（侧栏树行的菜单和详情的状态按钮共用）
  const STATUS_ORDER = ['doing', 'todo', 'done', 'question'];
  const ago = (t, now = Date.now()) => {
    const s = Math.max(0, Math.round((now - t) / 1000));
    return s < 60 ? T('ago.now') : s < 3600 ? T('ago.m', Math.round(s / 60)) : s < 86400 ? T('ago.h', Math.round(s / 3600)) : T('ago.d', Math.round(s / 86400));
  };
  // 深度优先走遍一棵（或几棵）树
  const walkNodes = (nodes, fn) => nodes.forEach(n => { fn(n); walkNodes(n.children, fn); });
  // 从根到 key 的路径（含它自己），找不到返回 null。「只看这一支」和「跟随 AI」都用
  function pathTo(nodes, key) {
    for (const n of nodes) {
      if (n.key === key) return [n];
      const p = pathTo(n.children, key);
      if (p) return [n, ...p];
    }
    return null;
  }
  // 用户是否偏好减少动态：是的话不做动画，直接切过去
  const reducedMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  // 折叠起来时，下面有 AI 在干活也要看得见
  const hasActive = n => n.children.some(c => c.active || hasActive(c));
  // 「久未动」的天数由 viewmodel 给出（data.staleDays），这里不写死
  const staleSpan = days => (days ? ` ${days} 天内` : '最近');

  // ---------- 线条图标 ----------
  // emoji 在 Windows / Mac / 无头浏览器里长得不一样（有的在 Windows 上是方框），界面一律用这组内联 SVG。
  // 24×24 画布、线宽 2、圆头，颜色跟随文字（currentColor），深浅主题自动适配。
  // 齿轮的齿用算的：8 个齿，齿顶半径 10、齿根 7.6
  const gear = (() => {
    const pt = (r, deg) => { const a = (deg - 90) * Math.PI / 180; return `${(12 + r * Math.cos(a)).toFixed(1)} ${(12 + r * Math.sin(a)).toFixed(1)}`; };
    let d = '';
    for (let i = 0; i < 8; i++) { const a = i * 45; d += `${i ? 'L' : 'M'}${pt(7.6, a - 16)}L${pt(10, a - 9)}L${pt(10, a + 9)}L${pt(7.6, a + 16)}`; }
    return `<path d="${d}Z"/><circle cx="12" cy="12" r="3"/>`;
  })();
  const ICONS = {
    ai: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V5"/><circle cx="12" cy="4" r="1"/><path d="M9.5 13v2M14.5 13v2M2 13v3M22 13v3"/>', // AI 正在改：机器人
    stale: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>', // 久未动：月亮
    rules: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>', // 规则：列表
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    map: '<circle cx="5" cy="12" r="2.5"/><circle cx="19" cy="5" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M7.5 12H10c2.5 0 2.5-7 6.5-7M10 12c2.5 0 2.5 7 6.5 7"/>', // 导图
    gear, // 设置
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>', // 铅笔
    delete: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/>', // 垃圾桶
    warn: '<path d="M12 3.5L2.5 20h19z"/><path d="M12 10v4M12 17h.01"/>',
    open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>', // 打开原文
    focus: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>', // 只看这一支：准星
    chev: '<path d="M9 6l6 6-6 6"/>', // 展开 / 收起（朝右：收着）
    chevd: '<path d="M6 9l6 6 6-6"/>', // 朝下：展开着
    more: '<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>', // 更多操作
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', // 完成
    minus: '<path d="M5 12h14"/>',
    status: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>', // 改状态：半圆
  };
  // 返回一段 SVG 字符串。size 是像素；attrs 追加属性（导图里用 x、y 定位，嵌在 SVG 里也能用）。
  // 图标只是装饰，一律 aria-hidden；按钮的可访问名称写在按钮的 aria-label 或旁边的文字上
  function icon(name, size = 14, attrs = '') {
    return `<svg class="ico ico-${name}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"${attrs ? ' ' + attrs : ''}>${ICONS[name] || ''}</svg>`;
  }

  // 结构化的文字（{ k: 文字表的键, a: 参数 }）按当前语言写出来；没有、或者键不认识，就用存下来的旧文字（旧记录、命令行写的）
  const tx = (t, fallback) => (t && t.k && window.ReqStrings && t.k in window.ReqStrings.zh ? T(t.k, ...(t.a || [])) : fallback);
  // 记录员的状态：新版本记了 parts（几段），按语言拼；旧版本只有 message
  function recorderText(r, file, showIds) {
    if (!r) return '';
    if (!r.ok) return tx(r.t, r.message);
    if (!Array.isArray(r.parts) || !r.parts.length || !r.parts.every(p => p && p.k && window.ReqStrings && p.k in window.ReqStrings.zh)) return r.message;
    const name = nodeNamer(file, showIds);
    return r.parts.map(p => ((p.k === 'rec.done' || p.k === 'rec.doing') ? T(p.k, (p.a[0] || []).map(name).map(x => x.trim()).join(T('rec.join')) + (T.lang === 'zh' && !/」$/.test(name((p.a[0] || []).slice(-1)[0]).trim()) ? ' ' : '')) : T(p.k, ...(p.a || []))).trim()).join(T('rec.sep'));
  }
  // 提到某个需求时写它的名字（打开「显示编号」时写编号）；树里已经没有了（删掉的）就写编号
  function nodeNamer(file, showIds) {
    const byId = {};
    walkNodes((file && file.nodes) || [], x => { byId[x.id] = x; });
    // 中文句子里名字带「」不用空格；写编号时前后补空格（拼好后再去掉首尾空格）
    const bare = id => (T.lang === 'zh' ? ` ${id} ` : id);
    return id => (showIds || !byId[id] ? bare(id) : T('d.quote', byId[id].title));
  }
  // 一次改动的说明：新旧版本都记了 ops（结构化），按当前语言重新写；认不出的（旧格式）用存下来的 summary
  function changeLines(c, file, showIds) {
    if (c.event) { const t = tx(c.event, null); if (t) return [t]; }
    const name = nodeNamer(file, showIds);
    const st = x => (x ? (STATUS_LABEL[x] || x) : T('op.noStatus'));
    const g = o => (o.globs || []).join(', ');
    const one = o => {
      switch (o && o.op) {
        case 'add_rule': return T('op.add_rule', name(o.node), o.text);
        case 'replace_rule': return T('op.replace_rule', name(o.node), o.old, o.text);
        case 'remove_rule': return T('op.remove_rule', name(o.node), o.text);
        case 'add_node': return T('op.add_node', showIds ? `${o.id} ${o.title}` : T('d.quote', o.title));
        case 'add_files': return T('op.add_files', name(o.node), g(o));
        case 'set_files': return (o.globs || []).length ? T('op.set_files', name(o.node), g(o)) : T('op.clear_files', name(o.node));
        case 'set_status': return T('op.set_status', name(o.node), st(o.status));
        case 'rename_node': {
          const old = (o.undo || []).find(u => u.op === 'rename_node');
          return T('op.rename_node', old && !showIds ? T('d.quote', old.title) : name(o.node), o.title);
        }
        case 'delete_node': {
          const head = ((o.undo || []).find(u => u.op === 'restore_node') || {}).lines;
          const m = head && /^#+\s+\S+\s+(.+?)\s*(?:[\u2705\u{1F528}\u23F3\u2753]\uFE0F?)?\s*$/u.exec(head[0] || '');
          return T('op.delete_node', m && !showIds ? T('d.quote', m[1]) : o.node);
        }
        case 'override_rule': return T('op.override_rule', name(o.node), o.text, o.new);
        // 删掉 Claude 自动记忆里和需求树重复的一句：写记忆文件名和那句话（太长的截短）
        case 'memory_remove': {
          const t = String(o.text || '');
          return T('op.memory_remove', String(o.file || '').split(/[\\/]/).pop(), t.length > 60 ? t.slice(0, 59) + '…' : t, !!o.wholeFile);
        }
        default: return null;
      }
    };
    if (Array.isArray(c.ops) && c.ops.length) {
      const lines = c.ops.map(one);
      if (lines.every(Boolean)) return lines.map(l => l.trim().replace(/ {2,}/g, ' '));
    }
    return c.summary || [];
  }

  // 顶部红色提示：记录员出错、规则没有生成。出错不能静悄悄，否则用户以为规则在生效
  function alertsHtml(file, now) {
    let h = '';
    const r = file.recorder;
    if (r && !r.ok) h += `<div class="banner err" role="alert"><span>${esc(T('alert.recorder', ago(r.time, now), tx(r.t, r.message)))}</span></div>`;
    const c = file.compile;
    if (c && c.ok === false) h += `<div class="banner err" role="alert"><span>${esc(T('alert.compile', tx(c.t, c.message)))}</span></div>`;
    return h;
  }

  // 浮动菜单贴着按钮下方右对齐（align='left' 时左对齐），靠近窗口边缘时往里收
  function placeMenu(menu, anchor, align = 'right') {
    const b = anchor.getBoundingClientRect();
    menu.style.top = Math.min(b.bottom + 2, innerHeight - menu.offsetHeight - 4) + 'px';
    const x = align === 'left' ? b.left : b.right - menu.offsetWidth;
    menu.style.left = Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4)) + 'px';
  }

  // 状态小圆点（HTML 版，侧栏和详情共用；导图在 map.js 里画同样的 SVG）。
  // 单色方案：进行中是强调色实心点，待做是灰色空心圈，完成是灰色勾，待定是灰色圈里一个问号
  // withTip=false：旁边已经写了状态名（菜单、状态按钮），不再给小圆点单独的悬停提示
  function dot(s, withTip = true) {
    // 「进行中」容易被看成「现在有 AI 在改」：悬停提示说清楚，AI 正在改的另有「AI 正在改」标记
    const tip = withTip ? ` title="${s === 'doing' ? T('st.doingTip') : STATUS_LABEL[s] || T('st.none')}"` : ' aria-hidden="true"';
    if (s === 'done') return `<span class="st st-done"${tip}>${icon('check', 12)}</span>`;
    if (s === 'question') return `<span class="st st-question"${tip}>?</span>`;
    return `<span class="st st-${s || 'none'}"${tip}></span>`;
  }

  // 需求详情：侧栏和导图共用。n 为空时显示最近改动和还没归属的文件。
  // data 提供 now、staleDays；页面另外给 folds（哪几节展开了，见 foldSec）、showIds、focusable / focusKey / focusLabel
  // 分节顺序：本需求的规则、继承的规则、子需求、最近改动 / 未归属的文件、生效范围。每节结尾一根淡线
  function html(file, n, data = {}) {
    const now = data.now;
    const U = `data-uri="${esc(file.uri)}"`;
    const recent = recentHtml(file, now, !!data.showIds, data) + unmappedHtml(file, data);
    if (!n) {
      return `<div class="dp-empty"><div class="empty">${T('d.empty')}</div>
        <button class="btn ghost new-btn" data-act="edit" data-a="addChild" data-node="${esc(file.nodes[0]?.id || '')}" ${U}>${icon('plus', 12)}${T('d.newReq')}</button></div>${recent}`;
    }
    const E = (a, extra = '') => `data-act="edit" data-a="${a}" data-node="${esc(n.id)}" ${U} ${extra}`;
    // 编号默认不显示（data.showIds 打开才显示）；提到别的需求时用它的名字
    const ids = !!data.showIds;
    const byId = {};
    walkNodes(file.nodes, x => { byId[x.id] = x; });
    const nameOf = id => (ids ? id : T('d.quote', byId[id]?.title || id));
    const path = pathTo(file.nodes, n.key) || [n];
    // 规则：前面一个灰色小圆点，折行时和第一行的字对齐；改写了上级的后面跟「覆盖上级」，被覆盖的划掉。详细说明在悬停提示里
    const rule = (r, g) => {
      const kind = ['own', 'inherit', 'overrides', 'overridden'].includes(r.state) ? r.state : 'own';
      const tip = kind === 'overrides' ? T('d.overridesTip', nameOf(r.ref)) : kind === 'overridden' ? (r.ref === n.id ? T('d.overriddenSelf') : T('d.overriddenBy', nameOf(r.ref))) : '';
      const tag = kind === 'overrides' ? T('d.tagOverrides') : kind === 'overridden' ? tip : '';
      let btns = '';
      if (g.self) btns = `<button class="ib" ${E('editRule', `data-text="${esc(r.text)}"`)} title="${T('d.editRule')}" aria-label="${T('d.editRule')}">${icon('edit', 13)}</button><button class="ib" ${E('deleteRule', `data-text="${esc(r.text)}"`)} title="${T('d.deleteRule')}" aria-label="${T('d.deleteRule')}">${icon('delete', 13)}</button>`;
      else if (kind !== 'overridden') btns = `<button class="ib wide" ${E('overrideRule', `data-text="${esc(r.text)}" data-from="${esc(g.ownerId)}"`)} title="${T('d.rewriteHereTip')}">${T('d.rewriteHere')}</button>`;
      return `<li class="rule r-${kind}"${tip ? ` title="${esc(tip)}"` : ''}><span class="tx"><span class="rt">${esc(r.text)}</span>${tag ? `<span class="tag">${esc(tag)}</span>` : ''}</span><span class="rb">${btns}</span></li>`;
    };
    // 体检给规则分过组（src/categories.js）的，按组显示：每组一个小标题，组的顺序照模型给的，没分到组的放最后「其他」
    const rules = (g, list) => {
      if (!list.some(r => r.cat)) return `<ul class="rules">${list.map(r => rule(r, g)).join('')}</ul>`;
      const byCat = new Map();
      for (const r of list) { const c = r.cat || ''; if (!byCat.has(c)) byCat.set(c, []); byCat.get(c).push(r); }
      const order = [...byCat.keys()].filter(Boolean).concat(byCat.has('') ? [''] : []);
      return order.map(c => `<div class="gcat">${esc(c || T('d.otherCat'))}<span class="gn">${byCat.get(c).length}</span></div><ul class="rules">${byCat.get(c).map(r => rule(r, g)).join('')}</ul>`).join('');
    };
    // 小标题：左边名字和条数，右边一个「+ 添加」（能加东西的节都一样）
    const addLink = (a, tip) => `<button class="lnk gh-act" ${E(a)} title="${tip}">${icon('plus', 12)}${T('d.add')}</button>`;
    const head = (title, count, add = '') => `<div class="gh"><span class="gt">${title}</span>${count ? `<span class="gn">${count}</span>` : ''}${add}</div>`;
    const sec = (cls, inner) => `<section class="sec ${cls}">${inner}</section>`;

    // 头部：大标题（点它改名，悬停提示里有编号）和右边的操作；下面是路径（只写名字）
    const focusBtn = data.focusable && data.focusKey !== n.key ? `<button class="lnk" data-act="focus" data-key="${esc(n.key)}" title="${T('d.focusTip')}">${esc(data.focusLabel || T('d.focusSide'))}</button>` : '';
    const crumbs = path.slice(0, -1).map(x => esc(ids ? `${x.id} ${x.title}` : x.title)).join(' › ');
    // 状态：只显示当前状态（符号 + 名字 + 小箭头），点开菜单再改。状态多数时候自动更新，这里只用来纠正，所以做成不起眼的文字按钮，和路径排在同一行
    const st = STATUS_LABEL[n.status] ? n.status : '';
    const stLabel = st ? STATUS_LABEL[st] : T('st.none');
    const statusBtn = `<button class="st-btn s-${st || 'none'}" data-act="statusMenu" data-node="${esc(n.id)}" data-status="${st}" ${U} aria-haspopup="menu" aria-expanded="false" aria-label="${esc(T('d.statusBtn', stLabel))}" title="${T('v.changeStatus')}">${dot(st, false)}<span class="st-l">${stLabel}</span>${icon('chevd', 12)}</button>`;
    let h = `<div class="sh">
        <div class="sh-title">${ids ? `<span class="sid">${esc(n.id)}</span>` : ''}<strong data-act="rename" data-node="${esc(n.id)}" ${U} tabindex="0" role="button" title="${esc(T('d.renameTip', n.id))}">${esc(n.title)}</strong><button class="ib pen" data-act="rename" data-node="${esc(n.id)}" ${U} title="${T('d.rename')}" aria-label="${T('d.rename')}">${icon('edit', 13)}</button>
          <span class="sh-acts">${focusBtn}<button class="ib more" data-act="more" data-node="${esc(n.id)}" data-key="${esc(n.key)}" data-line="${n.line}" data-raw="${esc(n.raw)}" ${U} title="${T('d.more')}" aria-label="${T('d.more')}" aria-haspopup="menu">${icon('more', 16)}</button></span></div>
        <div class="sh-meta">${statusBtn}${crumbs ? `<span class="sep" aria-hidden="true">·</span><span class="crumbs">${crumbs}</span>` : ''}</div>
      </div>`;
    // 久未动的提示：同一件事已经作为问题在问用户（问题队列里有这个需求的久未动问题，还开着），就不在面板里重复说
    const staleAsked = (file.questions || []).some(q => q && q.kind === 'stale' && q.node === n.id && (!q.status || q.status === 'open'));
    if (n.stale && !staleAsked) h += `<div class="hint">${icon('stale', 14)}<span>${esc(T('d.stale', data.staleDays))}</span></div>`;

    // 本需求的规则
    const own = n.groups.find(g => g.self);
    h += sec('s-own', head(T('d.ownRules'), own ? own.rules.length : 0, addLink('addRule', T('d.addRuleTip')))
      + (own ? rules(own, own.rules) : `<div class="empty sm">${T('d.noOwnRules')}</div>`));

    // 继承的规则：按来自哪一级分组；超过 3 条时小标题本身是开关，默认收起
    const up = n.groups.filter(g => !g.self);
    const total = up.reduce((k, g) => k + g.rules.length, 0);
    if (total) {
      const body = up.map(g => `<div class="gsub">${esc(ids ? T('d.fromId', g.ownerId, g.ownerTitle) : T('d.from', g.ownerTitle))}</div>${rules(g, g.rules)}`).join('');
      h += foldSec('s-inh', 'inh', data, T('d.inherited'), total, body, '', T('d.inheritedTip'));
    }

    // 子需求：状态点 + 名字，点一下选中；没有就只留小标题和「+ 添加」
    const addKid = addLink('addChild', T('d.addChildTip'));
    h += n.children.length
      ? foldSec('s-kids', 'kids', data, T('d.kids'), n.children.length, `<ul class="kids">${n.children.map(c => `<li><button class="kid" data-act="pick" data-key="${esc(c.key)}" title="${esc(c.id + ' ' + c.title)}">${dot(c.status)}${ids ? `<span class="kid-id">${esc(c.id)}</span>` : ''}<span class="kid-t">${esc(c.title)}</span></button></li>`).join('')}</ul>`, addKid)
      : sec('s-kids', head(T('d.kids'), 0, addKid));

    h += recent;

    // 生效范围：最下面一行。没写自己的就说和哪个上级相同
    const from = [...path].reverse().find(x => x.files && x.files.length);
    const scope = n.files.length ? n.files.map(g => `<code>${esc(g)}</code>`).join(T('d.scopeJoin'))
      : n.noScope ? `<span class="warn-t">${T('d.scopeNone')}</span>`
      : from && from !== n ? `<span>${esc(T('d.scopeSame', from.title))}</span>` : `<span>${T('d.scopeSameAny')}</span>`;
    h += `<div class="files${n.noScope ? ' warn' : ''}" title="${T('d.scopeTip')}"><span class="fk">${T('d.scope')}</span><span class="fv">${scope}</span><span class="fsep" aria-hidden="true">·</span><button class="lnk" ${E('setFiles')}>${n.files.length || !n.noScope ? T('d.change') : T('d.set')}</button></div>`;
    return h;
  }

  // 可以收起的一节（继承的规则、子需求、最近改动、未归属的文件）：小标题本身是开关，默认收起；
  // 只有「本需求的规则」一直展开。展开了哪几节由页面记在 webview state 里（data.folds），数据刷新、换需求都保持。
  // add：小标题右边的「+ 添加」（不在开关按钮里面）；tip：开关的悬停提示
  function foldSec(cls, key, data, title, count, body, add = '', tip = '') {
    const open = !!(data.folds && data.folds[key]);
    // 继承的规则沿用以前的类名和 id（inh-tg、inh-body）
    const id = key === 'inh' ? 'inh-body' : `fold-${key}`;
    return `<section class="sec ${cls}"><div class="gh fold-h"><button class="fold-tg${key === 'inh' ? ' inh-tg' : ''}" data-act="fold" data-sec="${key}" aria-expanded="${open}" aria-controls="${id}"${tip ? ` title="${tip}"` : ''}><span class="gt">${title}</span>${count ? `<span class="gn">${count}</span>` : ''}${icon('chev', 12)}</button>${add}</div>
      <div class="inh-body fold-body" id="${id}"${open ? '' : ' hidden'}>${body}</div></section>`;
  }

  // 最近改动：记录员和你的改动都在这里，记错了点「撤销」。
  // undoable === false 是旧版本留下、反操作已经翻译不了的改动：不给撤销按钮，免得点了没反应
  function recentHtml(file, now, showIds, data = {}) {
    const list = (file.changes || []).slice(0, 6);
    if (!list.length) return '';
    return foldSec('s-recent', 'recent', data, T('d.recent'), list.length, `<ul class="chgs">${list.map(c => {
      const fixed = !c.undone && c.undoable === false;
      return `<li class="chg${c.undone ? ' undone' : ''}">
      <div class="cw"><span class="who">${esc(c.source === '你' ? T('x.you') : c.source === '记录员' ? T('x.recorderName') : c.source === '升级' ? T('x.upgradeName') : c.source === '体检' ? T('x.checkupName') : c.source)}</span> · ${ago(c.time, now)}${c.undone ? ` · ${T('d.undone')}` : ''}${fixed ? ` · ${T('d.cantUndo')}` : ''}${c.undone || fixed ? '' : `<button class="lnk" data-act="undo" data-id="${esc(c.id)}" data-uri="${esc(file.uri)}">${T('d.undo')}</button>`}</div>
      ${changeLines(c, file, showIds).map(s => `<div class="cs">${esc(s)}</div>`).join('')}</li>`;
    }).join('')}</ul>`);
  }

  // AI 改了、但还不属于任何需求的文件：一键归到需求，以后改它们时就会带上对应规则
  function unmappedHtml(file, data = {}) {
    const list = file.unmapped || [];
    if (!list.length) return '';
    return foldSec('s-unmapped', 'unmapped', data, T('d.unmapped'), list.length, `<ul class="chgs">${list.map(f => `<li class="chg">
      <div class="cs"><code>${esc(f)}</code><button class="lnk" data-act="edit" data-a="assignFile" data-file="${esc(f)}" data-uri="${esc(file.uri)}">${T('d.assign')}</button></div></li>`).join('')}</ul>`);
  }

  // ---------- 在面板里直接改名：点标题或铅笔，标题变成输入框。回车保存，Esc 取消，点别处也保存；空名字不收 ----------
  let editing = null;
  const isEditing = () => !!editing;
  function startRename(a, post) {
    const box = a.closest('.sh-title');
    const strong = box && box.querySelector('strong');
    if (!strong || editing) return;
    const old = strong.textContent;
    const inp = document.createElement('input');
    inp.className = 'title-in';
    inp.value = old;
    inp.setAttribute('aria-label', T('d.nameLabel'));
    strong.replaceWith(inp);
    box.classList.add('editing');
    editing = { inp };
    inp.focus();
    inp.select();
    const finish = how => {
      if (!editing || editing.inp !== inp) return;
      const v = inp.value.trim();
      if (how === 'enter' && !v) { inp.setAttribute('aria-invalid', 'true'); inp.placeholder = T('d.nameEmpty'); return; }
      editing = null;
      inp.replaceWith(strong);
      box.classList.remove('editing');
      if (how && v && v !== old) {
        strong.textContent = v;
        post({ type: 'edit', uri: a.dataset.uri, action: 'rename', node: a.dataset.node, title: v });
      }
      window.dispatchEvent(new Event('reqdetail-editend'));
    };
    // 输入框里的按键不往外传：Esc 只取消改名，不退出聚焦、不取消变淡
    inp.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish('enter'); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    inp.addEventListener('input', () => inp.removeAttribute('aria-invalid'));
    inp.addEventListener('blur', () => finish('blur'));
  }

  // ---------- 上下文用量：AI 每个会话带上了哪些规则文件、各占多少字 ----------
  // file.context 是 viewmodel 给的最近 24 小时、最多 5 个会话（新的在前）。浮层盖在面板上，Esc 或「关闭」退出
  let ctx = null; // { el, file, idx, onPick }
  const num = n => (n == null ? '—' : Number(n).toLocaleString('en-US'));
  const base = p => String(p || '').split('/').pop();
  function hhmm(t, now) {
    const d = new Date(t), today = new Date(now);
    const pad = x => String(x).padStart(2, '0');
    const day = d.toDateString() === today.toDateString() ? '' : new Date(now - 86400000).toDateString() === d.toDateString() ? T('ctx.yesterday') : T('ctx.date', d.getMonth() + 1, d.getDate());
    return `${day}${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function contextHtml(file, idx, now = Date.now()) {
    const list = file.context || [];
    let h = `<div class="ctx-head"><span class="ctx-t">${T('ctx.title')}</span><button class="lnk" data-ctx="close">${T('ctx.close')}</button></div>
      <p class="ctx-sub">${T('ctx.sub')}</p>`;
    if (!list.length) return h + `<div class="ctx-empty">${T('ctx.empty')}</div>`;
    const s = list[Math.min(idx, list.length - 1)];
    const byId = {};
    walkNodes(file.nodes, x => { byId[x.id] = x; });
    h += `<label class="ctx-pick"><span>${T('ctx.session')}</span><select data-ctx="session">${list.map((x, i) =>
      `<option value="${i}"${x === s ? ' selected' : ''}>${esc(T('ctx.option', hhmm(x.start, now), x.agents))}</option>`).join('')}</select></label>`;
    const total = (s.resident || 0) + (s.demand || 0);
    const pct = v => (total ? Math.max(v ? 1.5 : 0, (v / total) * 100) : 0).toFixed(1);
    h += `<div class="ctx-bar" role="img" aria-label="${esc(T('ctx.bar', num(s.resident), num(s.demand)))}"><span class="cb-r" style="width:${pct(s.resident)}%"></span><span class="cb-d" style="width:${pct(s.demand)}%"></span></div>
      <div class="ctx-nums"><span><i class="sw sw-r"></i>${T('ctx.resident')} <b>${num(s.resident)}</b> ${T('ctx.chars')}</span> <span class="dot-sep">·</span> <span><i class="sw sw-d"></i>${T('ctx.demand')} <b>${num(s.demand)}</b> ${T('ctx.chars')}</span></div>
      ${s.reqtree ? `<div class="ctx-note">${T('ctx.note', num(s.reqtree))}</div>` : ''}`;
    const row = f => {
      let name;
      if (f.source === 'reqtree') {
        const n = f.node && byId[f.node];
        name = n ? `<button class="lnk ctx-node" data-ctx="pick" data-key="${esc(n.key)}" title="${esc(T('ctx.ruleTip', n.id))}">${esc(T('ctx.rule', n.title))}</button>` : `<span class="ctx-name">${T('ctx.index')}</span>`;
      } else name = `<span class="ctx-name" title="${esc(f.file)}">${esc(f.file)}</span>`;
      let why = f.kind === 'resident'
        ? (f.reason === 'compact' && f.source !== 'claude-md' ? T('ctx.compact') : T('ctx.always'))
        : f.reason === 'fallback' ? T('ctx.fallback') : f.trigger ? T('ctx.trigger', base(f.trigger)) : f.reason === 'nested_traversal' ? T('ctx.folder') : T('ctx.used');
      if (f.loads > 1) why += T('ctx.loads', f.loads);
      if (f.agents > 1) why += T('ctx.agents', f.agents);
      return `<div class="ctx-row ctx-${f.kind}"><div class="ctx-main">${name}<span class="ctx-chars">${T('ctx.charsN', num(f.chars))}</span></div><div class="ctx-why">${esc(why)}</div></div>`;
    };
    const res = s.files.filter(f => f.kind === 'resident'), dem = s.files.filter(f => f.kind !== 'resident');
    if (res.length) h += `<div class="ctx-gh">${T('ctx.resident')}<span class="gn">${res.length}</span></div>${res.map(row).join('')}`;
    if (dem.length) h += `<div class="ctx-gh">${T('ctx.demand')}<span class="gn">${dem.length}</span></div>${dem.map(row).join('')}`;
    return h;
  }
  function drawContext() {
    if (!ctx) return;
    ctx.el.querySelector('.ctx').innerHTML = contextHtml(ctx.file, ctx.idx, ctx.now);
  }
  function closeContext() {
    if (!ctx) return;
    const back = ctx.back;
    ctx.el.remove(); ctx = null;
    back?.focus?.();
  }
  // opts: { onPick(key) 点了需求的规则，now }
  function showContext(file, opts = {}) {
    closeContext();
    const el = document.createElement('div');
    el.className = 'ctx-ov';
    el.innerHTML = `<div class="ctx" role="dialog" aria-modal="true" aria-label="${T('ctx.title')}" tabindex="-1"></div>`;
    document.body.appendChild(el);
    ctx = { el, file, idx: 0, onPick: opts.onPick, now: opts.now || Date.now(), back: document.activeElement };
    drawContext();
    el.addEventListener('click', e => {
      e.stopPropagation();
      if (e.target === el) return closeContext(); // 点浮层外面
      const a = e.target.closest('[data-ctx]');
      if (!a) return;
      if (a.dataset.ctx === 'close') closeContext();
      else if (a.dataset.ctx === 'pick') { const k = a.dataset.key, pick = ctx.onPick; closeContext(); pick && pick(k); }
    });
    el.addEventListener('change', e => { if (e.target.dataset.ctx === 'session') { ctx.idx = +e.target.value; drawContext(); el.querySelector('select')?.focus(); } });
    el.querySelector('.ctx').focus();
  }
  // 数据更新时，浮层开着就跟着刷新
  function refreshContext(file, now) { if (ctx) { ctx.file = file; if (now) ctx.now = now; drawContext(); } }
  // 标题（role=button）也能用回车、空格开始改名
  document.addEventListener('keydown', e => {
    const t = e.target;
    if ((e.key === 'Enter' || e.key === ' ') && t && t.matches && t.matches('.sh-title strong[data-act]')) { e.preventDefault(); t.click(); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && ctx) { closeContext(); e.stopImmediatePropagation(); e.preventDefault(); } }, true);

  // ---------- 浮动菜单（⋯ 菜单；侧栏的状态菜单、设置菜单也用它的样式） ----------
  let openMenuEl = null, menuAnchor = null;
  // 关菜单；按钮上写了 aria-expanded 的改回 false。refocus：把焦点还给打开它的按钮（Esc、选了一项）
  function closeMenu(refocus) {
    const a = menuAnchor;
    openMenuEl?.remove(); openMenuEl = null; menuAnchor = null;
    if (a && a.hasAttribute('aria-expanded')) a.setAttribute('aria-expanded', 'false');
    if (refocus && a && a.isConnected) a.focus();
  }
  // items: [{ label, danger, run }]；opts：{ align: 'left' 左对齐（默认右对齐），label: 菜单的可访问名称，cls: 菜单多加的 class }
  function showMenu(anchor, items, opts = {}) {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'menu';
    m.setAttribute('role', 'menu');
    if (opts.label) m.setAttribute('aria-label', opts.label);
    if (opts.cls) m.classList.add(opts.cls);
    // item：label（文字）或 html（拼好的）；有 checked 的是单选项，选中的前面一个勾；data 写成 data-* 属性
    m.innerHTML = items.map((it, i) => {
      const radio = 'checked' in it;
      const attrs = Object.entries(it.data || {}).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
      return `<button role="${radio ? (it.toggle ? 'menuitemcheckbox' : 'menuitemradio') : 'menuitem'}"${radio ? ` aria-checked="${!!it.checked}"` : ''} data-i="${i}"${attrs}${it.danger ? ' class="danger"' : ''}>${radio ? `<span class="tick">${it.checked ? icon('check', 12) : ''}</span>` : ''}${it.html || esc(it.label)}</button>`;
    }).join('');
    document.body.appendChild(m);
    placeMenu(m, anchor, opts.align);
    m.addEventListener('click', ev => {
      const b = ev.target.closest('button');
      ev.stopPropagation();
      if (!b) return;
      closeMenu(true);
      items[+b.dataset.i].run();
    });
    // 方向键在菜单里上下移动（到头了绕回来），Home / End 到第一项、最后一项；Tab 关菜单回到按钮
    m.addEventListener('keydown', ev => {
      const btns = [...m.querySelectorAll('button')];
      const i = btns.indexOf(document.activeElement);
      const go = j => { ev.preventDefault(); btns[(j + btns.length) % btns.length]?.focus(); };
      if (ev.key === 'ArrowDown') go(i + 1);
      else if (ev.key === 'ArrowUp') go(i < 0 ? -1 : i - 1);
      else if (ev.key === 'Home') go(0);
      else if (ev.key === 'End') go(-1);
      else if (ev.key === 'Tab') { ev.preventDefault(); closeMenu(true); }
    });
    if (anchor.hasAttribute('aria-expanded')) anchor.setAttribute('aria-expanded', 'true');
    // 单选菜单先停在当前选中的那一项上
    (m.querySelector('[aria-checked="true"]') || m.querySelector('button'))?.focus();
    openMenuEl = m; menuAnchor = anchor;
    return m;
  }
  // 点菜单外面就关；点的是打开它的按钮（或 ⋯）时交给按钮自己处理开关
  document.addEventListener('click', e => { if (openMenuEl && !openMenuEl.contains(e.target) && !(menuAnchor && menuAnchor.contains(e.target)) && !e.target.closest('[data-act="more"]')) closeMenu(); }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && openMenuEl) { closeMenu(true); e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  // 状态按钮：回车、空格是按钮自带的；上下方向键也能打开菜单
  document.addEventListener('keydown', e => {
    const t = e.target;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && t && t.matches && t.matches('[data-act="statusMenu"]') && !openMenuEl) { e.preventDefault(); t.click(); }
  });
  window.addEventListener('blur', closeMenu);

  // 复制一小段文字（编号）：先用剪贴板接口，不行就用老办法
  function copyText(t) {
    const old = () => { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch {} ta.remove(); };
    try { navigator.clipboard.writeText(t).catch(old); } catch { old(); }
  }

  // 只改面板自己的点击（展开上级规则、⋯ 菜单）。post 用来把菜单里选的操作发给插件。
  // 返回 { fold: [哪一节, 展开没有] } 给页面记下；处理了但没状态要记返回 {}；不认识返回 null
  function local(a, post) {
    const d = a.dataset;
    if (d.act === 'rename') { startRename(a, post); return {}; }
    if (d.act === 'fold') {
      const open = a.getAttribute('aria-expanded') !== 'true';
      a.setAttribute('aria-expanded', String(open));
      const body = document.getElementById(a.getAttribute('aria-controls'));
      if (body) body.hidden = !open;
      return { fold: [d.sec, open] };
    }
    if (d.act === 'statusMenu') {
      if (openMenuEl && menuAnchor === a) { closeMenu(); return {}; }
      // 选了别的状态：发的消息和以前的状态分段按钮一样（edit / setStatus）；选当前的就只关菜单
      const cur = d.status || '';
      const set = s => post(message({ dataset: { act: 'edit', a: 'setStatus', node: d.node, uri: d.uri, status: s } }));
      const items = STATUS_ORDER.map(s => ({ html: dot(s, false) + `<span>${esc(STATUS_LABEL[s])}</span>`, data: { s }, checked: cur === s, run: () => { if (s !== cur) set(s); } }));
      if (cur) items.push({ label: T('v.clearStatus'), data: { s: '' }, run: () => set('') });
      showMenu(a, items, { align: 'left', label: T('d.status'), cls: 'st-menu' });
      return {};
    }
    if (d.act === 'more') {
      if (openMenuEl) { closeMenu(); return {}; }
      showMenu(a, [
        { label: T('menu.copyId', d.node), run: () => copyText(d.node) },
        { label: T('menu.delete'), danger: true, run: () => post({ type: 'edit', uri: d.uri, action: 'delete', node: d.node }) },
      ]);
      return {};
    }
    return null;
  }

  // 把面板里的点击转成发给插件的消息；不认识的按钮返回 null。
  // fallbackUri：按钮自己没带 data-uri 时用所在行的（插件靠 uri 找到是哪棵树，缺了就什么都不做）
  function message(a, fallbackUri) {
    const d = a.dataset;
    const uri = d.uri || fallbackUri;
    switch (d.act) {
      case 'edit': return { type: 'edit', uri, action: d.a, node: d.node, text: d.text, from: d.from, status: d.status, file: d.file };
      case 'undo': return { type: 'undo', uri, id: d.id };
      case 'open': return { type: 'open', uri, line: +d.line, expect: d.raw };
      default: return null;
    }
  }
  window.ReqDetail = { T, tx, recorderText, changeLines, html, message, local, isEditing, showContext, refreshContext, closeContext, contextHtml, showMenu, closeMenu, dot, alertsHtml, placeMenu, icon, esc, ago, walkNodes, hasActive, staleSpan, STATUS_LABEL, STATUS_ORDER, pathTo, reducedMotion };
})();
