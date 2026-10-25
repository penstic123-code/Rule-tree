// 手绘风小库：Rough.js + 霞鹜文楷，画在 SVG 上。页面调用 sketch(w, h, g => {...})。
const C = {
  ink: '#2b2620', paper: '#fbf6ea', red: '#b4432a', green: '#2f6f5e', blue: '#2f5f8f', muted: '#5f574c',
  yellow: '#ffe7a3', pink: '#f8d3c4', mint: '#d3eadf', sky: '#dbe6f3', gray: '#e9e2d3', gold: '#e2b23c',
};
const EN = window.LANG === 'en';
const FONT = EN ? '"Patrick Hand", "LXGW WenKai", sans-serif' : '"LXGW WenKai", "Kaiti SC", "KaiTi", serif';
const TS = EN ? 1.1 : 1; // Patrick Hand 的字面偏小，英文版整体放大一点
const NS = 'http://www.w3.org/2000/svg';
window.__wait = true;

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

async function sketch(W, H, fn) {
  const allText = [...document.scripts].map(s => s.textContent).join('') + '0123456789,./%()（）：:·—…×↩✓✗？！';
  try {
    await Promise.all([document.fonts.load(`400 16px "LXGW WenKai"`, allText), document.fonts.load(`700 16px "LXGW WenKai"`, allText)].concat(EN ? [document.fonts.load(`400 16px "Patrick Hand"`, allText)] : []));
    await document.fonts.ready;
  } catch (e) { console.log('font load error ' + e); }
  const stage = document.getElementById('stage');
  stage.style.width = W + 'px'; stage.style.height = H + 'px';
  const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` }, stage);
  el('rect', { x: 0, y: 0, width: W, height: H, fill: C.paper }, svg);
  const rc = rough.svg(svg);
  let seed = 7;
  const texts = [], avoid = [];
  const base = o => Object.assign({ stroke: C.ink, strokeWidth: 1.6, roughness: 1.1, bowing: 1, seed: seed++, fillStyle: 'solid' }, o || {});
  const layer = el('g', {}, svg);
  const add = (n, parent) => (parent || layer).appendChild(n);

  const g = {
    W, H, svg, rc, C,
    group(attrs) { return el('g', attrs || {}, layer); },
    rect(x, y, w, h, o = {}) { return add(rc.rectangle(x, y, w, h, base(o)), o.parent); },
    line(x1, y1, x2, y2, o = {}) { return add(rc.line(x1, y1, x2, y2, base(o)), o.parent); },
    circle(cx, cy, d, o = {}) { return add(rc.circle(cx, cy, d, base(o)), o.parent); },
    ellipse(cx, cy, w, h, o = {}) { return add(rc.ellipse(cx, cy, w, h, base(o)), o.parent); },
    path(d, o = {}) { return add(rc.path(d, base(o)), o.parent); },
    poly(pts, o = {}) { return add(rc.polygon(pts, base(o)), o.parent); },
    // 箭头：直线或弯曲（bend 为垂直偏移量）
    arrow(x1, y1, x2, y2, o = {}) {
      const color = o.color || C.ink, sw = o.sw || 1.8, bend = o.bend || 0;
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
      const cx = mx - dy / len * bend, cy = my + dx / len * bend;
      const opt = base({ stroke: color, strokeWidth: sw, roughness: 0.8, strokeLineDash: o.dash });
      add(rc.path(`M${x1} ${y1} Q${cx} ${cy} ${x2} ${y2}`, opt), o.parent);
      const ang = Math.atan2(y2 - cy, x2 - cx), a = 0.45, L = o.head || 12;
      const p1 = [x2 - L * Math.cos(ang - a), y2 - L * Math.sin(ang - a)], p2 = [x2 - L * Math.cos(ang + a), y2 - L * Math.sin(ang + a)];
      add(rc.linearPath([p1, [x2, y2], p2], base({ stroke: color, strokeWidth: sw, roughness: 0.6 })), o.parent);
    },
    // 文字：str 用 \n 分行；anchor start|middle|end；返回 {el, box}
    text(x, y, str, o = {}) {
      const size = (o.size || 16) * TS, lh = o.lh || size * 1.35;
      const t = el('text', { x, y, fill: o.color || C.ink, 'font-family': FONT, 'font-size': size, 'font-weight': o.weight || 400, 'text-anchor': o.anchor || 'start', 'dominant-baseline': 'middle' }, o.parent || layer);
      if (o.rot) t.setAttribute('transform', `rotate(${o.rot} ${x} ${y})`);
      if (o.deco) t.setAttribute('text-decoration', o.deco);
      String(str).split('\n').forEach((line, i) => { const s = el('tspan', { x, dy: i ? lh : 0 }, t); s.textContent = line; });
      if (o.check !== false) texts.push(t);
      return t;
    },
    measure(str, size = 16, weight = 400) {
      const t = el('text', { x: 0, y: -100, 'font-family': FONT, 'font-size': size * TS, 'font-weight': weight }, svg);
      t.textContent = str; const w = t.getComputedTextLength(); t.remove(); return w;
    },
    avoid(x, y, w, h, name) { avoid.push({ x, y, w, h, name }); },
    // 便利贴：带胶带，可旋转
    note(x, y, w, h, o = {}) {
      const grp = el('g', { transform: `rotate(${o.rot || 0} ${x + w / 2} ${y + h / 2})` }, layer);
      add(rc.rectangle(x + 3, y + 4, w, h, base({ stroke: 'none', fill: 'rgba(60,40,20,0.10)', roughness: 0.4 })), grp);
      add(rc.rectangle(x, y, w, h, base({ fill: o.fill || C.yellow, strokeWidth: 1.2, roughness: 0.7 })), grp);
      if (o.tape !== false) add(rc.rectangle(x + w / 2 - 22, y - 8, 44, 16, base({ fill: 'rgba(240,235,220,0.85)', stroke: 'rgba(120,110,90,0.5)', strokeWidth: 1, roughness: 0.6 })), grp);
      if (o.text) g.text(x + (o.anchor === 'start' ? 12 : w / 2), y + (o.ty || h / 2 - ((o.text.split('\n').length - 1) * (o.size || 16) * TS * 1.35) / 2), o.text, { size: o.size || 16, anchor: o.anchor || 'middle', color: o.color, weight: o.weight, parent: grp });
      return grp;
    },
    // 文档纸：折角 + 标题
    doc(x, y, w, h, o = {}) {
      const f = 18;
      add(rc.polygon([[x + 4, y + 5], [x + w - f + 4, y + 5], [x + w + 4, y + f + 5], [x + w + 4, y + h + 5], [x + 4, y + h + 5]], base({ stroke: 'none', fill: 'rgba(60,40,20,0.10)', roughness: 0.4 })), o.parent);
      add(rc.polygon([[x, y], [x + w - f, y], [x + w, y + f], [x + w, y + h], [x, y + h]], base({ fill: o.fill || '#fffdf6', strokeWidth: 1.5 })), o.parent);
      add(rc.linearPath([[x + w - f, y], [x + w - f, y + f], [x + w, y + f]], base({ strokeWidth: 1.2 })), o.parent);
      if (o.title) g.text(x + 12, y + 20, o.title, { size: o.tsize || 17, weight: 700, color: o.tcolor || C.ink, parent: o.parent });
    },
    // 对话气泡：tail 指向 [tx, ty]
    bubble(x, y, w, h, tx, ty, o = {}) {
      const r = 14, cx = x + w / 2;
      const bx = Math.max(x + 20, Math.min(x + w - 40, tx - 10));
      const bottom = ty > y + h;
      let d;
      const by = Math.max(y + 12, Math.min(y + h - 30, ty - 9));
      if (tx > x + w) d = `M${x + r} ${y} H${x + w - r} Q${x + w} ${y} ${x + w} ${y + r} V${by} L${tx} ${ty} L${x + w} ${by + 18} V${y + h - r} Q${x + w} ${y + h} ${x + w - r} ${y + h} H${x + r} Q${x} ${y + h} ${x} ${y + h - r} V${y + r} Q${x} ${y} ${x + r} ${y} Z`;
      else if (tx < x) d = `M${x + r} ${y} H${x + w - r} Q${x + w} ${y} ${x + w} ${y + r} V${y + h - r} Q${x + w} ${y + h} ${x + w - r} ${y + h} H${x + r} Q${x} ${y + h} ${x} ${y + h - r} V${by + 18} L${tx} ${ty} L${x} ${by} V${y + r} Q${x} ${y} ${x + r} ${y} Z`;
      else if (bottom) d = `M${x + r} ${y} H${x + w - r} Q${x + w} ${y} ${x + w} ${y + r} V${y + h - r} Q${x + w} ${y + h} ${x + w - r} ${y + h} H${bx + 22} L${tx} ${ty} L${bx} ${y + h} H${x + r} Q${x} ${y + h} ${x} ${y + h - r} V${y + r} Q${x} ${y} ${x + r} ${y} Z`;
      else d = `M${x + r} ${y} H${bx} L${tx} ${ty} L${bx + 22} ${y} H${x + w - r} Q${x + w} ${y} ${x + w} ${y + r} V${y + h - r} Q${x + w} ${y + h} ${x + w - r} ${y + h} H${x + r} Q${x} ${y + h} ${x} ${y + h - r} V${y + r} Q${x} ${y} ${x + r} ${y} Z`;
      add(rc.path(d, base({ fill: o.fill || '#fffdf6', strokeWidth: 1.5, roughness: 0.7 })), o.parent);
      if (o.text) { const n = o.text.split('\n').length, s = o.size || 16; g.text(o.anchor === 'start' ? x + 14 : cx, y + h / 2 - (n - 1) * s * TS * 1.35 / 2, o.text, { size: s, anchor: o.anchor || 'middle', color: o.color, weight: o.weight }); }
    },
    // 人物：脚踩 (x, feetY)；hair: 'short'|'bun'|'cap'；glasses；pose: 'head'(抱头)|'point'|'type'|'stand'
    person(x, fy, o = {}) {
      const s = o.scale || 1, shirt = o.shirt || C.sky;
      if (o.tiptoe) fy -= 9 * s;
      const P = (dx, dy) => [x + dx * s, fy + dy * s];
      const hy = fy - 150 * s;
      g.avoid(x - 40 * s, fy - 175 * s, 80 * s, 175 * s, o.name || 'person');
      // 腿（落地）
      g.line(...P(-8, -62), ...P(-14, 0), { strokeWidth: 2.4 }); g.line(...P(8, -62), ...P(14, 0), { strokeWidth: 2.4 });
      if (o.tiptoe) { g.line(...P(-14, 0), ...P(-20, 9), { strokeWidth: 3 }); g.line(...P(14, 0), ...P(20, 9), { strokeWidth: 3 }); }
      else { g.line(...P(-22, 0), ...P(-8, 0), { strokeWidth: 3 }); g.line(...P(8, 0), ...P(22, 0), { strokeWidth: 3 }); }
      // 身体（衣服）
      g.path(`M${P(-22, -120)} Q${P(0, -128)} ${P(22, -120)} L${P(18, -60)} L${P(-18, -60)} Z`.replace(/,/g, ' '), { fill: shirt, strokeWidth: 1.8 });
      // 手臂
      const pose = o.pose || 'stand';
      if (pose === 'head') {
        // 抱头的手臂画在头之后（见下方），手按在耳朵位置，不压头发
      } else if (pose === 'point') {
        g.path(`M${P(-20, -114)} Q${P(-30, -90)} ${P(-24, -66)}`.replace(/,/g, ' '), { strokeWidth: 2.2 });
        g.line(...P(20, -114), ...P(56, -136), { strokeWidth: 2.2 });
      } else {
        g.path(`M${P(-20, -114)} Q${P(-30, -90)} ${P(-24, -66)}`.replace(/,/g, ' '), { strokeWidth: 2.2 });
        g.path(`M${P(20, -114)} Q${P(30, -90)} ${P(24, -66)}`.replace(/,/g, ' '), { strokeWidth: 2.2 });
      }
      // 头
      // 发髻先画，压在头后面；头发盖住整个头顶，额前留一道弧
      if (o.hair === 'bun') g.circle(...P(0, -183), 19 * s, { fill: C.ink, fillStyle: 'solid' });
      g.circle(x, hy, 52 * s, { fill: '#f6dcc0', strokeWidth: 1.8 });
      if (o.hair === 'bun') g.path(`M${P(-26.5, -146)} C${P(-29, -170)} ${P(-15, -177)} ${P(0, -177)} C${P(15, -177)} ${P(29, -170)} ${P(26.5, -146)} Q${P(14, -160)} ${P(0, -159)} Q${P(-14, -160)} ${P(-26.5, -146)} Z`.replace(/,/g, ' '), { fill: C.ink, roughness: 0.6 });
      else if (o.hair === 'cap') { g.path(`M${P(-26, -156)} Q${P(0, -190)} ${P(26, -156)} Z`.replace(/,/g, ' '), { fill: C.red }); g.line(...P(14, -157), ...P(40, -155), { strokeWidth: 3, stroke: C.red }); }
      else g.path(`M${P(-26, -150)} Q${P(-20, -182)} ${P(4, -178)} Q${P(28, -178)} ${P(26, -148)} Q${P(8, -164)} ${P(-26, -150)}`.replace(/,/g, ' '), { fill: '#4a3a2c' });
      // 眼睛 + 嘴
      if (o.glasses) { g.circle(...P(-10, -150), 14 * s, { strokeWidth: 1.4 }); g.circle(...P(10, -150), 14 * s, { strokeWidth: 1.4 }); g.line(...P(-3, -150), ...P(3, -150), { strokeWidth: 1.2 }); }
      el('circle', { cx: x - 10 * s, cy: hy, r: 2.2 * s, fill: C.ink }, layer); el('circle', { cx: x + 10 * s, cy: hy, r: 2.2 * s, fill: C.ink }, layer);
      if (o.mood === 'worried') g.path(`M${P(-8, -134)} Q${P(0, -140)} ${P(8, -134)}`.replace(/,/g, ' '), { strokeWidth: 1.6, roughness: 0.4 });
      else g.path(`M${P(-8, -138)} Q${P(0, -132)} ${P(8, -138)}`.replace(/,/g, ' '), { strokeWidth: 1.6, roughness: 0.4 });
      if (pose === 'head') for (const k of [-1, 1]) {
        g.path(`M${P(20 * k, -114)} Q${P(50 * k, -122)} ${P(33 * k, -142)}`.replace(/,/g, ' '), { strokeWidth: 2.2 });
        g.circle(...P(30 * k, -143), 11 * s, { fill: '#f6dcc0', strokeWidth: 1.6 });
      }
    },
    // 机器人：底座落地 (x, fy)
    robot(x, fy, o = {}) {
      const s = o.scale || 1, P = (dx, dy) => [x + dx * s, fy + dy * s];
      g.avoid(x - 46 * s, fy - 150 * s, 92 * s, 150 * s, o.name || 'robot');
      g.rect(...P(-30, -8), 60 * s, 8 * s, { fill: C.gray }); // 底座
      g.line(...P(-12, -36), ...P(-12, -8), { strokeWidth: 3 }); g.line(...P(12, -36), ...P(12, -8), { strokeWidth: 3 });
      g.rect(...P(-30, -90), 60 * s, 56 * s, { fill: o.body || C.mint }); // 身体
      g.circle(...P(0, -64), 14 * s, { fill: C.gold });
      // 手臂
      g.path(`M${P(-30, -80)} Q${P(-46, -62)} ${P(-40, -44)}`.replace(/,/g, ' '), { strokeWidth: 2.4 });
      g.path(`M${P(30, -80)} Q${P(46, -62)} ${P(40, -44)}`.replace(/,/g, ' '), { strokeWidth: 2.4 });
      g.rect(...P(-26, -134), 52 * s, 40 * s, { fill: '#eef3f1' }); // 头
      g.line(...P(0, -134), ...P(0, -146), { strokeWidth: 2 }); g.circle(...P(0, -148), 8 * s, { fill: C.red });
      const eye = o.eyes || 'dot';
      if (eye === 'spiral') { g.circle(...P(-10, -116), 11 * s, { strokeWidth: 1.4 }); g.circle(...P(10, -116), 11 * s, { strokeWidth: 1.4 }); el('circle', { cx: P(-10, -116)[0], cy: P(-10, -116)[1], r: 2, fill: C.ink }, layer); el('circle', { cx: P(10, -116)[0], cy: P(10, -116)[1], r: 2, fill: C.ink }, layer); }
      else { el('circle', { cx: P(-10, -116)[0], cy: P(-10, -116)[1], r: 3 * s, fill: C.ink }, layer); el('circle', { cx: P(10, -116)[0], cy: P(10, -116)[1], r: 3 * s, fill: C.ink }, layer); }
      g.line(...P(-8, -103), ...P(8, -103), { strokeWidth: 1.6, roughness: 0.3 });
    },
    // 把 fn 画出的所有元素收进一个灰调组（左半边"麻烦"用）
    muted(fn, style = 'filter:grayscale(1);opacity:.8') {
      const n0 = layer.childNodes.length; fn();
      const grp = el('g', { style }); const nodes = [...layer.childNodes].slice(n0);
      nodes.forEach(n => grp.appendChild(n)); layer.appendChild(grp);
    },
    // 按宽度折行：中文按字，英文按词；行首标点挪回上一行
    wrap(str, width, size = 15) {
      const toks = EN ? str.split(' ').map((w, i, a) => i < a.length - 1 ? w + ' ' : w) : [...str];
      const greedy = W => {
        const lines = []; let cur = '';
        for (const t of toks) { if (cur && g.measure((cur + t).trimEnd(), size) > W) { lines.push(cur.trimEnd()); cur = t; } else cur += t; }
        if (cur) lines.push(cur.trimEnd());
        for (let i = 1; i < lines.length; i++) while (/^[，。；：、？！）」,.;:!?)]/.test(lines[i])) { lines[i - 1] += lines[i][0]; lines[i] = lines[i].slice(1); }
        return lines;
      };
      const best = greedy(width);
      if (best.length < 2) return best;
      // 均衡折行：在不增加行数的前提下找最窄的宽度，避免最后一行只剩一两个字
      let lo = width / best.length, hi = width;
      while (hi - lo > 2) { const mid = (lo + hi) / 2; if (greedy(mid).length <= best.length) hi = mid; else lo = mid; }
      return greedy(hi + 1);
    },
    // 脚注框：lines 为数组，框高随行数
    footnote(y, lines, o = {}) {
      const lh = o.lh || 24;
      g.rect(24, y - 16, 752, lines.length * lh + 10, { fill: '#f3ecdc', stroke: 'none', roughness: 0.4 });
      lines.forEach((l, i) => g.text(36, y + i * lh, l, { size: o.size || 14 }));
    },
    // 小标签（圆角色块 + 字）
    tag(x, y, str, o = {}) {
      const size = o.size || 14, w = g.measure(str, size, o.weight || 700) + 16, h = size + 10;
      g.rect(x, y - h / 2, w, h, { fill: o.fill || C.gray, strokeWidth: 1, roughness: 0.6 });
      g.text(x + 8, y + 1, str, { size, weight: o.weight || 700, color: o.color });
      return w;
    },
  };
  await fn(g);
  // 自查：文字之间、文字与人物/机器人是否重叠
  window.__overlaps = () => {
    const r = texts.map(t => ({ t: t.textContent.slice(0, 14), b: t.getBoundingClientRect() }));
    const sb = svg.getBoundingClientRect();
    const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    const out = [];
    for (let i = 0; i < r.length; i++) {
      for (let j = i + 1; j < r.length; j++) if (hit(r[i].b, r[j].b)) out.push(r[i].t + ' <> ' + r[j].t);
      for (const a of avoid) { const ab = { left: sb.left + a.x, right: sb.left + a.x + a.w, top: sb.top + a.y, bottom: sb.top + a.y + a.h }; if (hit(r[i].b, ab)) out.push(r[i].t + ' <> ' + a.name); }
      const b = r[i].b; if (b.left < sb.left || b.right > sb.right || b.top < sb.top || b.bottom > sb.bottom) out.push(r[i].t + ' 出界');
    }
    return out;
  };
  window.__done = true;
}
