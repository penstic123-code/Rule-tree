'use strict';
// 面板界面测试：用 Edge 或 Chrome 无头模式打开预览页，检查布局、对比度、交互，并截图到 test/out/。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');
const { spawn, execFileSync } = require('child_process');
const { build } = require('../tools/preview');

// 找一个 Chromium 内核的浏览器：环境变量优先，再按 Windows、macOS、Linux 的常见位置找
const BROWSER = [
  process.env.REQTREE_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => p && fs.existsSync(p));
// CI 设了 REQTREE_REQUIRE_BROWSER：找不到浏览器要报错，不能悄悄跳过
if (!BROWSER && process.env.REQTREE_REQUIRE_BROWSER) throw new Error('没有找到 Edge 或 Chrome（可以用 REQTREE_BROWSER 指定路径）');
const OUT = path.join(__dirname, 'out');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TREE = `# P 示例项目
- [段落] 段落不超过 4 行
- [语气] 语气柔和自然，少用"你"

## G1 写作
- 先场景后概念

### G1.1 文风
- [文风] 古典风格加非虚构写作，平实但高级

## C2 数据科学课 🔨
> 文件：DataScience/**
- [文风] 不引原话，全部自己叙述
- [引用] 每章引原话不超过两处

### C2.1 第1章开场与练习题的整体重写 🔨
> 文件：DataScience/ch01-*.html
- 开场用霍乱的故事

### C2.2 英文版 ⏳
> 文件：DataScience/en/**
- [读者] 澳大利亚高中生，用澳式拼写
- 术语第一次出现时附中文对照

### C2.3 练习题解析
- 每题都有解析

## C3 人类学课 ❓
## C4 英语课 ✅
`;

// 还开着的浏览器：测试超时时 finally 不会执行，靠文件结束（after）和进程退出时统一关掉，免得 node --test 一直等着
const LIVE = new Set();
const closeAll = () => { for (const b of [...LIVE]) b.close(); };
test.after(closeAll);
process.on('exit', closeAll);

// 等某件事成立，超时返回 false；每一轮最多等 step 毫秒
async function until(fn, ms, step = 100) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) {
    try { if (await fn()) return true; } catch {}
  }
  return false;
}
// fetch 加超时（Node 20 / 22 都有 AbortSignal.timeout）
const getJson = (u, method = 'GET') => fetch(u, { method, signal: AbortSignal.timeout(3000) }).then(r => r.json());

class Browser {
  // 打开一个全新的无头浏览器（独立的临时配置目录），连上它唯一的空白页
  async open(width) {
    LIVE.add(this);
    this.logs = []; // 页面报错、控制台错误，失败时附在报错信息里
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqtree-browser-'));
    this.stderr = path.join(this.dir, 'stderr.log');
    // 端口给 0：浏览器自己挑空闲端口，写进配置目录下的 DevToolsActivePort，不会和别的进程撞端口
    const args = ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${this.dir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-default-apps',
      '--disable-background-networking', '--disable-component-update', '--mute-audio'];
    if (process.platform === 'linux') args.push('--no-sandbox'); // CI 容器里没有沙箱权限
    const err = fs.openSync(this.stderr, 'w');
    // macOS / Linux 上放进单独的进程组，关的时候整组杀掉（Windows 用 taskkill /T）
    this.proc = spawn(BROWSER, [...args, 'about:blank'], { stdio: ['ignore', 'ignore', err], detached: process.platform !== 'win32' });
    fs.closeSync(err);
    this.proc.on('error', e => { this.dead = true; this.logs.push('启动失败：' + e.message); });
    this.proc.on('exit', () => (this.dead = true));
    this.proc.unref();

    const portFile = path.join(this.dir, 'DevToolsActivePort');
    let port;
    await until(() => {
      port = fs.existsSync(portFile) && Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
      return port > 0 || this.dead;
    }, 30000);
    if (!(port > 0)) throw new Error(`浏览器没有起来（${this.dead ? '进程已退出，退出码 ' + this.proc.exitCode : '等了 30 秒'}）${this.diag()}`);
    this.base = `http://127.0.0.1:${port}`;

    // 只连 about:blank 那一页：Edge 还有内置扩展的后台页，有时还有别的内部页面，连错了就会在错的页面上找元素
    let target;
    await until(async () => {
      const list = await getJson(`${this.base}/json/list`);
      this.targets = list.map(t => `${t.type} ${t.url}`);
      target = list.find(t => t.type === 'page' && t.url === 'about:blank');
      return target;
    }, 15000, 250);
    if (!target) { // 没有空白页就自己开一个
      try { target = await getJson(`${this.base}/json/new?about:blank`, 'PUT'); } catch (e) { this.logs.push('新建标签页失败：' + e.message); }
    }
    if (!target?.webSocketDebuggerUrl) throw new Error(`找不到可用的页面${this.diag()}`);

    this.id = 0; this.pending = new Map();
    this.ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`连不上浏览器调试接口${this.diag()}`)), 15000);
      this.ws.onopen = () => { clearTimeout(t); resolve(); };
      this.ws.onerror = e => { clearTimeout(t); reject(new Error(`连接浏览器调试接口出错：${e.message || e.type}${this.diag()}`)); };
    });
    this.ws.onmessage = m => {
      const d = JSON.parse(m.data);
      if (this.pending.has(d.id)) { this.pending.get(d.id).resolve(d); this.pending.delete(d.id); return; }
      const p = d.params || {};
      if (d.method === 'Runtime.exceptionThrown') this.logs.push('页面异常：' + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
      else if (d.method === 'Runtime.consoleAPICalled' && /error|warn/.test(p.type)) this.logs.push(`console.${p.type}：` + (p.args || []).map(a => a.value ?? a.description).join(' '));
      else if (d.method === 'Log.entryAdded' && /error|warning/.test(p.entry?.level)) this.logs.push(`${p.entry.source}：${p.entry.text} ${p.entry.url || ''}`);
      else if (d.method === 'Inspector.targetCrashed') this.logs.push('页面崩溃了');
      if (this.logs.length > 40) this.logs.splice(0, this.logs.length - 40);
    };
    this.ws.onclose = () => { for (const [, p] of this.pending) p.reject(new Error(`浏览器连接断了${this.diag()}`)); this.pending.clear(); };
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 2, mobile: false });
  }
  // 发一条调试命令；30 秒没回音就报错（不让测试一直挂着）
  send(method, params = {}, ms = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error(`浏览器没连上，不能发 ${method}${this.diag()}`));
      const id = ++this.id;
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} ${ms / 1000} 秒没有回应${this.diag()}`)); }, ms);
      this.pending.set(id, { resolve: d => { clearTimeout(t); resolve(d); }, reject: e => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  // 打开预览页，等页面真的加载完、脚本跑起来（发出 ready）再继续；超时报出页面当时的状态
  async load(file) {
    const href = url.pathToFileURL(file).href;
    const nav = await this.send('Page.navigate', { url: href });
    if (nav.error || nav.result?.errorText) throw new Error(`打开 ${href} 失败：${nav.error?.message || nav.result.errorText}${this.diag()}`);
    const name = encodeURIComponent(path.basename(file));
    let st;
    const ok = await until(async () => {
      const r = await this.send('Runtime.evaluate', { returnByValue: true, expression: `({ href: location.href, ready: document.readyState, data: typeof window.__data,
        posted: (window.__posted || []).map(m => m.type).join(','), errors: window.__errors || [], body: document.body ? document.body.children.length : -1 })` });
      st = r.result?.result?.value || r.result?.exceptionDetails || r.error;
      return st && st.ready === 'complete' && st.data === 'object' && st.href.endsWith('/' + name) && /\bready\b/.test(st.posted);
    }, 20000, 150);
    if (!ok) throw new Error(`页面 20 秒内没有加载完：${JSON.stringify(st)}${this.diag()}`);
    await sleep(700); // 和原来一样留出渲染、动画的时间
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(()=>{${expr}})()`, returnByValue: true, awaitPromise: true });
    if (r.error) throw new Error(`eval 出错：${r.error.message}${this.diag()}`);
    if (r.result.exceptionDetails) {
      const e = new Error((r.result.exceptionDetails.exception?.description || 'eval 出错') + this.diag());
      throw e;
    }
    return r.result.result.value;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  }
  // 出错时附上的现场：浏览器路径、页面列表、页面报错、浏览器 stderr 的最后几行
  diag() {
    let err = '';
    try { err = fs.readFileSync(this.stderr, 'utf8').trim().split(/\r?\n/).slice(-8).join('\n    '); } catch {}
    return `\n  浏览器：${BROWSER}` + (this.targets ? `\n  页面列表：${this.targets.join(' | ')}` : '') +
      (this.logs?.length ? `\n  页面日志：\n    ${this.logs.slice(-15).join('\n    ')}` : '') + (err ? `\n  浏览器 stderr：\n    ${err}` : '');
  }
  close() {
    LIVE.delete(this);
    try { this.ws?.close(); } catch {}
    const p = this.proc;
    if (p && p.exitCode === null && p.signalCode === null) {
      // Windows 上 kill 只杀主进程，渲染进程会留下来；用 taskkill /T 连子进程一起杀
      if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 }); } catch {} }
      else { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }
      try { p.kill('SIGKILL'); } catch {}
    }
    // 删掉临时配置目录（Windows 上进程刚退出时文件可能还锁着，重试几次，删不掉就算了）
    if (this.dir) { try { fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} this.dir = null; }
  }
}

// 页面内：算一个元素文字对背景的对比度
const CONTRAST = `
  // 兼容 rgb(0-255) 和 color-mix 产生的 color(srgb 0-1 ... / a)
  const rgb = s => {
    const isColor = s.startsWith('color(');
    const m = s.replace(/^color\\(srgb/, '').match(/[\\d.]+/g).map(Number);
    const k = isColor ? 255 : 1;
    return { r: m[0] * k, g: m[1] * k, b: m[2] * k, a: m.length > 3 ? m[3] : 1 };
  };
  const lum = c => [c.r, c.g, c.b].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
  const over = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  function bgOf(el) {
    const layers = [];
    for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.a > 0) layers.push(c); }
    return layers.reverse().reduce((acc, c) => over(c, acc), { r: 255, g: 255, b: 255, a: 1 });
  }
  function contrast(el) {
    const bg = bgOf(el);
    const cs = getComputedStyle(el);
    let fg = rgb(cs.color); fg = over({ ...fg, a: fg.a * Number(cs.opacity) }, bg);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (a + .05) / (b + .05);
  }`;

// 页面内：图标和 emoji 的检查（侧栏、导图共用）
//   emoji：页面上能看到的文字（跳过 script / style）和 title、aria-label 里不许有 emoji
//   图标：每个 .ico 都是 aria-hidden；只有图标没有文字的按钮必须有 aria-label 或 title
const ICON_CHECK = `
  const EMOJI = /[\\p{Extended_Pictographic}\\uFE0F]/u;
  const emoji = [];
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t; (t = tw.nextNode());) {
    if (/^(SCRIPT|STYLE)$/.test(t.parentNode.nodeName)) continue;
    if (EMOJI.test(t.nodeValue)) emoji.push(t.nodeValue.trim());
  }
  for (const el of document.querySelectorAll('[title], [aria-label]'))
    for (const a of ['title', 'aria-label']) if (EMOJI.test(el.getAttribute(a) || '')) emoji.push(a + '=' + el.getAttribute(a));
  const icons = [...document.querySelectorAll('svg.ico')];
  const notHidden = icons.filter(s => s.getAttribute('aria-hidden') !== 'true').map(s => s.getAttribute('class'));
  const noStroke = icons.filter(s => s.getAttribute('stroke') !== 'currentColor').map(s => s.getAttribute('class'));
  const unnamed = [...document.querySelectorAll('button, [role="button"]')]
    .filter(b => !b.textContent.trim() && !b.getAttribute('aria-label') && !b.getAttribute('title'))
    .map(b => b.outerHTML.slice(0, 80));`;

// Node 20 要加 --experimental-websocket 才有全局 WebSocket
const skip = (!BROWSER && '没有找到 Edge 或 Chrome') || (typeof WebSocket === 'undefined' && '这个 Node 没有全局 WebSocket（Node 20 要加 --experimental-websocket）');

for (const theme of ['dark', 'light']) {
  for (const width of [260, 340]) {
    test(`界面：${theme} ${width}px`, { skip, timeout: 60000 }, async () => {
      fs.mkdirSync(OUT, { recursive: true });
      const treeFile = path.join(OUT, 'ui-tree.md');
      fs.writeFileSync(treeFile, TREE);
      const html = path.join(OUT, `ui-${theme}-${width}.html`);
      fs.writeFileSync(html, build({
        treeFile, theme, selId: 'C2.2', activeId: 'C2.1', width,
        changes: [{ id: 'c1', time: Date.now() - 60000, source: '记录员', summary: ['把 C2.1 的「开场用勇士」改成「开场用霍乱」'], undone: false }],
        unmapped: ['notes/plan.md'],
        recorder: { ok: true, time: Date.now() - 120000, message: '记下 2 条要求；C2.1 标为正在做' },
        touched: { 'C2.1': Date.now() },
      }));
      const b = new Browser();
      try {
        await b.open(width);
        await b.load(html);
        const r = await b.eval(`${CONTRAST}
          const out = {};
          out.overflowX = document.documentElement.scrollWidth - innerWidth;
          out.rows = document.querySelectorAll('.row').length;
          out.detailTitle = document.querySelector('.dp .sh strong')?.textContent;
          out.ai = document.querySelectorAll('.chip.ai').length;
          out.aiIcon = !!document.querySelector('.chip.ai svg.ico-ai');
          out.status = document.querySelector('.status')?.textContent || '';
          // 对比度：正文、次要文字、标签、按钮
          const checks = ['.row .title', '.crumbs', '.rule .why', '.gh', '.status', '.chip.ai', '.id', '.btn', '.files code', '.files', '.st-btn', '.chg .cs', '.statusbar .ibtn', '.dp .ib'];
          out.contrast = {};
          for (const s of checks) { const els = [...document.querySelectorAll(s)]; if (els.length) out.contrast[s] = Math.min(...els.map(contrast)); }
          // 行内元素是否互相压住（标题被右侧标签挤没）
          out.squeezed = [...document.querySelectorAll('.row')].filter(r => r.querySelector('.title').getBoundingClientRect().width < 24).map(r => r.dataset.key);
          // 常驻按钮要完整可见、点得到（没被裁掉或盖住）；点到按钮里的图标也算点到按钮
          out.hiddenButtons = [...document.querySelectorAll('.statusbar button, .files button, .actions button, .st-btn, .chg button, .dp .btn.add')]
            .filter(btn => {
              btn.scrollIntoView({ block: 'nearest' });
              const r = btn.getBoundingClientRect();
              if (r.width < 8 || r.right > innerWidth || r.left < 0) return true;
              const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              return !(hit === btn || btn.contains(hit));
            }).map(b => b.title || b.textContent);
          // 图标和同一按钮里的文字垂直居中对齐（差不超过 2px）
          out.misaligned = [...document.querySelectorAll('button svg.ico')].filter(s => s.getClientRects().length).filter(s => {
            const btn = s.closest('button'), ir = s.getBoundingClientRect(), br = btn.getBoundingClientRect();
            return ir.height < 8 || Math.abs((ir.top + ir.bottom) / 2 - (br.top + br.bottom) / 2) > 2;
          }).map(s => s.closest('button').textContent || s.closest('button').getAttribute('aria-label'));
          document.querySelector('.tree').scrollTop = 0; document.querySelector('.detail').scrollTop = 0;
          return out;`);
        await b.shot(path.join(OUT, `ui-${theme}-${width}.png`));

        assert.ok(r.overflowX <= 0, `横向溢出 ${r.overflowX}px`);
        assert.strictEqual(r.rows, 9);
        assert.strictEqual(r.detailTitle, '英文版');
        assert.ok(r.ai >= 1, '没有显示 AI 正在改');
        assert.ok(r.aiIcon, 'AI 正在改要用线条图标');
        assert.match(r.status, /记录员 · 2 分钟前/);
        assert.deepStrictEqual(r.squeezed, [], '标题被挤没了');
        assert.deepStrictEqual(r.hiddenButtons, [], '有按钮被裁掉或盖住');
        assert.deepStrictEqual(r.misaligned, [], '图标和按钮文字没对齐');
        for (const [sel, c] of Object.entries(r.contrast)) assert.ok(c >= 4.5, `${sel} 对比度 ${c.toFixed(2)} < 4.5`);

        // 交互：点状态、加规则、撤销、归属文件；点行 → 选中；点三角 → 折叠；设置菜单
        const posted = await b.eval(`
          document.querySelector('.st-btn').click();
          [...document.querySelectorAll('.menu button')].find(x => x.dataset.s === 'done').click();
          document.querySelector('[data-a="addRule"]').click();
          document.querySelector('.chg [data-act="undo"]').click();
          document.querySelector('[data-a="assignFile"]').click();
          document.querySelector('.row[data-key$="#G1"]').click();
          const sel = document.querySelector('.dp .sh strong').textContent;
          document.querySelector('.row[data-key$="#C2"] .twisty').click();
          const rowsAfter = document.querySelectorAll('.row').length;
          document.querySelector('.gear[data-act="settings"]').click();
          const items = [...document.querySelectorAll('.menu button[data-v]')].map(x => x.getAttribute('aria-checked'));
          const labels = [...document.querySelectorAll('.menu button')].map(x => x.textContent);
          document.querySelectorAll('.menu button')[1].click();
          const cfg = window.__posted.filter(m => m.type === 'setConfig').pop();
          return { posted: window.__posted.map(m => m.type), all: window.__posted, sel, rowsAfter, aiCollapsed: !!document.querySelector('.row[data-key$="#C2"] .chip.ai svg.ico-ai'), items, labels, cfg };`);
        assert.deepStrictEqual(posted.items, ['true', 'false'], '默认：每轮记录');
        assert.ok(posted.labels.every(l => !/确认/.test(l)), `设置菜单里还有确认模式：${posted.labels}`);
        assert.deepStrictEqual(posted.cfg.patch, { recorder: 'off' });
        const edits = posted.all.filter(m => m.type === 'edit');
        assert.deepStrictEqual(edits.map(m => m.action), ['setStatus', 'addRule', 'assignFile']);
        assert.strictEqual(edits[0].status, 'done');
        assert.strictEqual(edits[0].node, 'C2.2');
        assert.strictEqual(edits[2].file, 'notes/plan.md');
        assert.ok(posted.all.some(m => m.type === 'undo' && m.id === 'c1'));
        assert.strictEqual(posted.sel, '写作');
        assert.strictEqual(posted.rowsAfter, 6, '折叠后子节点应隐藏');
        assert.ok(posted.aiCollapsed, '折叠后上级也要显示 AI 正在改的图标');
      } finally { b.close(); }
    });
  }
}

test('界面：记录员出错时显示红色提示', { skip, timeout: 60000 }, async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const treeFile = path.join(OUT, 'ui-tree.md');
  fs.writeFileSync(treeFile, TREE);
  const html = path.join(OUT, 'ui-error.html');
  fs.writeFileSync(html, build({ treeFile, recorder: { ok: false, time: Date.now(), message: '模型返回错误：Not logged in' } }));
  const b = new Browser();
  try {
    await b.open(340);
    await b.load(html);
    const t = await b.eval(`return document.querySelector('.banner.err')?.textContent || ''`);
    assert.match(t, /记录员出错.*Not logged in/);
  } finally { b.close(); }
});

test('界面：撤销不了的旧改动（undoable: false）不显示撤销按钮', { skip, timeout: 60000 }, async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const treeFile = path.join(OUT, 'ui-tree.md');
  fs.writeFileSync(treeFile, TREE);
  const html = path.join(OUT, 'ui-undoable.html');
  const changes = [
    { id: 'old', time: Date.now() - 60000, source: '记录员', summary: ['旧版本记下的'], undone: false, undoable: false },
    { id: 'ok', time: Date.now(), source: '你', summary: ['加了一条'], undone: false },
  ];
  fs.writeFileSync(html, build({ treeFile, selId: 'C2.1', changes }));
  const b = new Browser();
  try {
    await b.open(340);
    await b.load(html);
    const r = await b.eval(`return [...document.querySelectorAll('.chg')].map(c => ({ text: c.textContent, undo: !!c.querySelector('[data-act="undo"]') }))`);
    assert.strictEqual(r.length, 2);
    const old = r.find(c => c.text.includes('旧版本记下的'));
    assert.strictEqual(old.undo, false, '撤销不了的改动还显示撤销按钮');
    assert.match(old.text, /不能撤销/);
    assert.strictEqual(r.find(c => c.text.includes('加了一条')).undo, true);
  } finally { b.close(); }
});

test('导图：卡片、连线、选中看规则、折叠、缩放', { skip, timeout: 60000 }, async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const treeFile = path.join(OUT, 'ui-tree.md');
  fs.writeFileSync(treeFile, TREE);
  for (const theme of ['dark', 'light']) {
    const html = path.join(OUT, `map-${theme}.html`);
    fs.writeFileSync(html, build({ treeFile, theme, activeId: 'C2.1', width: 1200, height: 760, mode: 'map' }));
    const b = new Browser();
    try {
      await b.open(1200);
      await b.load(html);
      const r = await b.eval(`
        const out = { cards: document.querySelectorAll('.card').length, links: document.querySelectorAll('.link').length };
        out.overflowX = document.documentElement.scrollWidth - innerWidth;
        out.ai = !!document.querySelector('.badge.ai svg.ico-ai');
        out.summaryAi = !!document.querySelector('#summary svg.ico-ai');
        out.banner = !!document.getElementById('banner');
        document.querySelector('.card[data-key$="#C2.2"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        out.side = document.querySelector('#side .sh strong')?.textContent;
        out.sideRules = document.querySelectorAll('#side .rule').length;
        document.querySelector('[data-toggle$="#C2"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        out.cardsAfter = document.querySelectorAll('.card').length;
        out.collapsedAi = !!document.querySelector('.card[data-key$="#C2"] .badge.ai svg.ico-ai');
        const before = document.getElementById('world').getAttribute('transform');
        document.querySelector('[data-act="zoomIn"]').click();
        out.zoomed = before !== document.getElementById('world').getAttribute('transform');
        return out;`);
      await b.shot(path.join(OUT, `map-${theme}.png`));
      assert.strictEqual(r.cards, 9);
      assert.strictEqual(r.links, 8);
      assert.ok(r.overflowX <= 0, `横向溢出 ${r.overflowX}px`);
      assert.ok(r.ai, '没有显示 AI 正在改');
      assert.ok(r.summaryAi, '概况里的 AI 正在改没有图标');
      assert.ok(!r.banner, '待确认横幅应该已删除');
      assert.strictEqual(r.side, '英文版');
      assert.ok(r.sideRules >= 2);
      assert.strictEqual(r.cardsAfter, 6, '折叠 C2 后它的 3 个子需求应隐藏');
      assert.ok(r.collapsedAi, '折叠后上级也要显示 AI 正在改的图标');
      assert.ok(r.zoomed, '放大按钮没反应');
    } finally { b.close(); }
  }
});

test('网页的安全策略允许元素上的内联样式（分支颜色靠它）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(src, /style-src \$\{webview\.cspSource\} 'unsafe-inline'/);
  assert.doesNotMatch(src, /script-src[^;"]*unsafe-inline/, '脚本不能放行 inline');
});

test('导图：右边展开子需求，下面展开规则，各自独立', { skip, timeout: 60000 }, async () => {
  const treeFile = path.join(OUT, 'ui-tree.md');
  fs.writeFileSync(treeFile, TREE);
  const html = path.join(OUT, 'map-rules.html');
  fs.writeFileSync(html, build({ treeFile, theme: 'dark', width: 1200, height: 760, mode: 'map' }));
  const b = new Browser();
  try {
    await b.open(1200);
    await b.load(html);
    const r = await b.eval(`
      const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const out = { linesBefore: document.querySelectorAll('.rl').length };
      const h0 = +document.querySelector('.card[data-key$="#C2.2"] .box').getAttribute('height');
      click(document.querySelector('[data-rules$="#C2.2"]'));
      out.linesAfter = document.querySelectorAll('.rl').length;
      out.grew = +document.querySelector('.card[data-key$="#C2.2"] .box').getAttribute('height') > h0;
      out.cardsSame = document.querySelectorAll('.card').length;
      click(document.querySelector('[data-toggle$="#C2"]'));
      out.rulesStillOnRoot = document.querySelectorAll('.card[data-key$="#P"] .rl').length;
      document.querySelector('[data-act="rulesAll"]').click();
      out.allLines = document.querySelectorAll('.rl').length;
      document.querySelector('[data-act="compactAll"]').click();
      out.noneLines = document.querySelectorAll('.rl').length;
      // 卡片不互相重叠
      const boxes = [...document.querySelectorAll('.card .box')].map(e => e.getBBox());
      out.overlap = boxes.some((a, i) => boxes.some((c, j) => i < j && a.x === c.x && a.y < c.y + c.height && c.y < a.y + a.height));
      document.querySelector('[data-act="rulesAll"]').click();
      const boxes2 = [...document.querySelectorAll('.card .box')].map(e => e.getBBox());
      out.overlapAll = boxes2.some((a, i) => boxes2.some((c, j) => i < j && a.x === c.x && a.y < c.y + c.height && c.y < a.y + a.height));
      return out;`);
    await b.shot(path.join(OUT, 'map-rules.png'));
    assert.strictEqual(r.linesBefore, 0, '默认规则收起');
    assert.strictEqual(r.linesAfter, 2, 'C2.2 有 2 条规则');
    assert.ok(r.grew, '展开规则后卡片变高');
    assert.strictEqual(r.cardsSame, 9, '展开规则不影响子需求');
    assert.strictEqual(r.allLines, 6, '全部展开（C2 已折叠，只算看得见的卡片：P 2 + G1 1 + G1.1 1 + C2 2）');
    assert.strictEqual(r.noneLines, 0, '全部收起');
    assert.ok(!r.overlap && !r.overlapAll, '卡片互相重叠了');
  } finally { b.close(); }
});

// ---------- 回归测试（2026-10-22 代码审查发现的界面问题） ----------

// 打开一个预览页，返回浏览器；用完要 close
async function openPage(name, opts, width) {
  fs.mkdirSync(OUT, { recursive: true });
  const treeFile = path.join(OUT, 'ui-tree.md');
  fs.writeFileSync(treeFile, TREE);
  const html = path.join(OUT, name);
  fs.writeFileSync(html, build({ treeFile, ...opts }));
  const b = new Browser();
  await b.open(width);
  await b.load(html);
  return b;
}

test('侧栏：树行上的「打开原文」「改状态」发出的消息都带 uri，改状态走可撤销的 edit', { skip, timeout: 60000 }, async () => {
  const b = await openPage('reg-row-uri.html', { activeId: 'C2.1' }, 340);
  try {
    const r = await b.eval(`
      const row = id => document.querySelector('.row[data-key$="#' + id + '"]');
      row('C2.1').querySelector('[data-act="open"]').click();
      row('C2.1').querySelector('[data-act="status"]').click();
      [...document.querySelectorAll('.menu button')].find(x => x.dataset.s === 'done').click();
      row('C2.1').querySelector('[data-act="status"]').click();
      [...document.querySelectorAll('.menu button')].find(x => x.dataset.s === '').click();
      // 按钮自己没有 data-uri 时用调用方给的兜底
      const bare = document.createElement('button'); bare.dataset.act = 'open'; bare.dataset.line = '3';
      const fb = ReqDetail.message(bare, 'file:///fallback.md');
      // 确认模式的消息已经没有了：旧按钮就算还在，也不发
      const gone = ['accept', 'reject', 'moveUp'].map(a => { const x = document.createElement('button'); x.dataset.act = a; return ReqDetail.message(x, 'file:///x.md'); });
      return { posted: window.__posted.filter(m => m.type !== 'ready'), fb, gone, errors: window.__errors };`);
    assert.deepStrictEqual(r.errors, []);
    const [open, st1, st2] = r.posted;
    assert.strictEqual(open.type, 'open');
    for (const m of r.posted) assert.strictEqual(m.uri, 'file:///tree.md', `${m.type} 没带 uri`);
    assert.deepStrictEqual({ ...st1 }, { type: 'edit', action: 'setStatus', node: 'C2.1', status: 'done', uri: 'file:///tree.md' });
    assert.strictEqual(st2.status, '', '清除状态');
    assert.strictEqual(r.fb.uri, 'file:///fallback.md');
    assert.deepStrictEqual(r.gone, [null, null, null]);
  } finally { b.close(); }
});

// 核心那边删字段前后，界面都要能用：旧数据里还带着 pending 系列字段时，也不显示任何确认模式的东西
const OLD_FIELDS = `
  const d = structuredClone(window.__data);
  d.pendingTotal = 3;
  for (const f of d.files) {
    f.pending = 3;
    const mark = n => {
      Object.assign(n, { pending: n.id === 'C2.3' ? 'add' : null, pendingSelf: 2, pendingDeep: 5, pendingCount: 1, pendingFiles: [{ globs: ['x/**'], line: 1, raw: 'x' }] });
      n.groups.forEach(g => g.rules.forEach(r => { r.pending = 'add'; r.canMoveUp = true; }));
      n.children.forEach(mark);
    };
    f.nodes.forEach(mark);
  }
  window.postMessage(d, '*');`;
const CONFIRM_UI = `.chip.new, .badge.new, .card.pending, .pending, .files.pf, .r-add, .r-remove, #banner, .banner:not(.err),
  [data-act="accept"], [data-act="reject"], [data-act="moveUp"], [data-act="acceptAll"], [data-act="rejectAll"]`;

test('确认模式已删：侧栏和导图都没有待确认的横幅、徽章、按钮（带旧字段的数据也一样）', { skip, timeout: 60000 }, async () => {
  for (const [name, opts, w, before] of [
    ['reg-noconfirm-side.html', { selId: 'C2.2' }, 340, ''],
    ['reg-noconfirm-side-old.html', { selId: 'C2.2' }, 340, OLD_FIELDS],
    ['reg-noconfirm-map.html', { width: 1200, height: 760, mode: 'map' }, 1200, ''],
    ['reg-noconfirm-map-old.html', { width: 1200, height: 760, mode: 'map' }, 1200, OLD_FIELDS],
  ]) {
    const b = await openPage(name, opts, w);
    try {
      const r = await b.eval(`${before}
        return new Promise(res => setTimeout(() => {
          // 导图里点一张卡片，让右侧详情也渲染出来
          document.querySelector('.card[data-key$="#C2.2"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          res({ found: [...document.querySelectorAll(\`${CONFIRM_UI}\`)].map(e => e.outerHTML.slice(0, 80)),
            text: /待确认|全部确认|全部拒绝|先让我确认/.test(document.body.innerText), errors: window.__errors,
            rules: document.querySelectorAll('.dp .rule').length });
        }, 100));`);
      assert.deepStrictEqual(r.errors, [], name);
      assert.deepStrictEqual(r.found, [], `${name}：还有确认模式的界面`);
      assert.ok(!r.text, `${name}：还有确认模式的文案`);
      assert.ok(r.rules >= 2, `${name}：规则没显示出来`);
    } finally { b.close(); }
  }
});

test('导图：徽章和规则开关的文字不被截断、不超出底框；.toggle 样式没有套到 SVG 上', { skip, timeout: 60000 }, async () => {
  const b = await openPage('reg-badge.html', { activeId: 'C2.1', width: 1200, height: 760, mode: 'map' }, 1200);
  try {
    const r = await b.eval(`
      // 标题行右边的徽章（AI、久未动）、展开开关、标题文字互不相压（底框之间、和标题之间都不重叠；折叠前后各查一次）
      const overlapX = (a, c) => a.x < c.x + c.width && c.x < a.x + a.width;
      const collide = () => [...document.querySelectorAll('.card')].filter(c => {
        // 只看底框（> rect），图标里也有 rect（机器人的脸），坐标是图标自己的
        const tags = [...c.querySelectorAll('.badge > rect, .rchip > rect')].map(e => e.getBBox());
        const title = c.querySelector('.ctitle').getBBox();
        return tags.some(t => overlapX(t, title)) || tags.some((t, i) => tags.some((u, j) => i < j && overlapX(t, u)));
      }).map(c => c.dataset.key);
      const collideBefore = collide();
      // 展开 C2.1：说明行写出 AI 在改的文件，窄卡片上可以截断，但要留下文件名开头
      document.querySelector('[data-rules$="#C2.1"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const aiFile = document.querySelector('.card[data-key$="#C2.1"] .cai-t')?.textContent || '';
      document.querySelector('[data-toggle$="#C2"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const out = { aiFile, ai: document.querySelector('.card[data-key$="#C2"] .badge.ai title')?.textContent };
      // 图标和文字（按实际渲染的框）都要放得进底框，左右各留 3px；图标在文字左边、不相压；图标上下居中
      out.overflow = [...document.querySelectorAll('.badge, .rchip, .pill')].map(g => {
        const box = g.querySelector(':scope > rect').getBBox(), t = g.querySelector('text'), ic = g.querySelector('svg.ico');
        const parts = [t && t.getBBox(), ic && { x: +ic.getAttribute('x'), y: +ic.getAttribute('y'), width: +ic.getAttribute('width'), height: +ic.getAttribute('height') }].filter(Boolean);
        const left = Math.min(...parts.map(p => p.x)), right = Math.max(...parts.map(p => p.x + p.width));
        const bad = [];
        if (left < box.x + 3 || right > box.x + box.width - 3) bad.push('出框');
        if (ic && t && Math.abs((left - box.x) - (box.x + box.width - right)) > 2) bad.push('左右留白不一样');
        if (ic && t && ic.x.baseVal.value + ic.width.baseVal.value > t.getBBox().x + 0.5) bad.push('图标压字');
        if (ic && Math.abs(ic.y.baseVal.value + ic.height.baseVal.value / 2 - (box.y + box.height / 2)) > 1) bad.push('图标没居中');
        return { t: g.textContent, bad };
      }).filter(x => x.bad.length);
      // 短标签一律不该被截（长文件名除外）
      out.cut = [...document.querySelectorAll('.rchip text, .badge.stale text, .card[data-key$="#C2"] .badge.ai text')].map(t => t.textContent).filter(t => t.includes('…'));
      out.rchipIcons = [...document.querySelectorAll('.rchip')].every(g => g.querySelector('svg.ico-chev, svg.ico-chevd'));
      out.collide = [...collideBefore, ...collide()];
      const g = getComputedStyle(document.querySelector('g.toggle'));
      out.toggleCss = { display: g.display, marginTop: g.marginTop };
      return out;`);
    assert.strictEqual(r.ai, '下面有需求 AI 正在改');
    assert.deepStrictEqual(r.cut, [], '标签被截断');
    assert.deepStrictEqual(r.collide, [], '徽章、展开开关、标题互相压住了');
    assert.match(r.aiFile, /AI 正在改 ch01-cholera/, '展开后要写出 AI 在改的文件');
    assert.deepStrictEqual(r.overflow, [], '图标或文字超出底框、互相压住或没居中');
    assert.ok(r.rchipIcons, '展开开关要有箭头图标');
    assert.notStrictEqual(r.toggleCss.display, 'flex', '侧栏的 .toggle 样式套到了导图的 <g class="toggle">');
    assert.strictEqual(r.toggleCss.marginTop, '0px');
  } finally { b.close(); }
});

test('图标：界面里没有 emoji；图标都 aria-hidden、跟随文字颜色；只有图标的按钮有名字（侧栏和导图，深浅两种主题）', { skip, timeout: 90000 }, async () => {
  // sinceDays: 10 让 C2.1 以外没被 AI 改过的「正在做」变成久未动，把月亮图标也测到
  for (const theme of ['dark', 'light']) {
    for (const [name, opts, w] of [
      [`reg-icons-side-${theme}.html`, { theme, selId: 'C2.1', activeId: 'C2.2', sinceDays: 10, changes: [{ id: 'c1', time: Date.now(), source: '记录员', summary: ['加了一条'], undone: false }], unmapped: ['a.md'] }, 340],
      [`reg-icons-map-${theme}.html`, { theme, selId: 'C2.1', activeId: 'C2.2', sinceDays: 10, width: 1200, height: 760, mode: 'map' }, 1200],
    ]) {
      const b = await openPage(name, opts, w);
      try {
        const r = await b.eval(`${CONTRAST}${ICON_CHECK}
          // 详情里规则的「改」「删」平时藏着，悬停才出来：强制显示后检查
          document.querySelectorAll('.dp .rule .rb').forEach(e => (e.style.display = 'inline-flex'));
          const names = [...new Set(icons.map(s => s.getAttribute('class').replace('ico ico-', '')))].sort();
          // 看得见的图标要真的画出来（导图会缩放，只要求不是 0）
          const empty = icons.filter(s => s.getClientRects().length).filter(s => { const r = s.getBoundingClientRect(); return r.width < 2 || r.height < 2 || !s.firstElementChild; }).map(s => s.getAttribute('class'));
          const stale = document.querySelector('.chip.stale, .badge.stale');
          const hint = document.querySelector('.dp .hint span');
          return { emoji, notHidden, noStroke, unnamed, names, empty, staleIcon: !!stale?.querySelector('svg.ico-stale'),
            hintC: hint ? contrast(hint) : 9, staleC: document.querySelector('.chip.stale') ? contrast(document.querySelector('.chip.stale')) : 9, errors: window.__errors };`);
        await b.shot(path.join(OUT, name.replace('.html', '.png')));
        assert.deepStrictEqual(r.errors, [], name);
        assert.deepStrictEqual(r.emoji, [], `${name}：界面里还有 emoji`);
        assert.deepStrictEqual(r.notHidden, [], `${name}：图标没有 aria-hidden`);
        assert.deepStrictEqual(r.noStroke, [], `${name}：图标不跟随文字颜色`);
        assert.deepStrictEqual(r.unnamed, [], `${name}：只有图标的按钮没有名字`);
        assert.deepStrictEqual(r.empty, [], `${name}：有图标没画出来`);
        assert.ok(r.staleIcon, `${name}：久未动没有月亮图标`);
        assert.ok(r.hintC >= 4.5 && r.staleC >= 4.5, `${name}：对比度不够 ${r.hintC.toFixed(2)} / ${r.staleC.toFixed(2)}`);
        const want = name.includes('side') ? ['ai', 'chev', 'delete', 'edit', 'gear', 'map', 'more', 'open', 'plus', 'stale', 'status'] : ['ai', 'chev', 'more', 'stale'];
        for (const n of want) assert.ok(r.names.includes(n), `${name}：没用到图标 ${n}（用到的：${r.names}）`);
      } finally { b.close(); }
    }
  }
});

test('图标集：ReqDetail.icon 每个名字都有图形，未知名字不报错', { skip, timeout: 60000 }, async () => {
  const b = await openPage('reg-icon-api.html', {}, 340);
  try {
    const r = await b.eval(`
      const names = ['ai', 'stale', 'rules', 'folder', 'map', 'gear', 'undo', 'plus', 'edit', 'delete', 'warn', 'open', 'status'];
      const host = document.createElement('div'); document.body.appendChild(host);
      const out = names.map(n => { host.innerHTML = ReqDetail.icon(n, 24); const s = host.firstElementChild; const bb = s.getBBox ? [...s.children].map(c => c.getBBox()) : [];
        return { n, kids: s.children.length, size: s.getAttribute('width'), area: Math.max(0, ...bb.map(x => x.width * x.height)), hidden: s.getAttribute('aria-hidden') }; });
      host.innerHTML = ReqDetail.icon('nope');
      return { out, unknown: host.innerHTML.length > 0 };`);
    for (const x of r.out) {
      assert.ok(x.kids > 0 && x.area > 4, `图标 ${x.n} 是空的`);
      assert.strictEqual(x.size, '24');
      assert.strictEqual(x.hidden, 'true');
    }
    assert.ok(r.unknown);
  } finally { b.close(); }
});

test('package.json 声明的命令都在插件里注册了，没有「全部确认」', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const cmds = pkg.contributes.commands.map(c => c.command);
  assert.ok(!cmds.includes('reqtree.acceptAll'));
  assert.ok(!JSON.stringify(pkg.contributes.menus).includes('acceptAll'));
  for (const c of cmds) assert.ok(ext.includes(`'${c}'`), `${c} 没在 extension.js 里注册`);
});

test('源码里没有 emoji（media 下的脚本、样式、页面骨架）', () => {
  const dir = path.join(__dirname, '..', 'media');
  for (const f of fs.readdirSync(dir)) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    const bad = lines.map((l, i) => [i + 1, l]).filter(([, l]) => /[\p{Extended_Pictographic}️]/u.test(l)).map(([i, l]) => `${f}:${i} ${l.trim().slice(0, 60)}`);
    assert.deepStrictEqual(bad, [], 'media 里还有 emoji');
  }
});

test('导图：数据到达前滚轮、缩放、工具栏按钮不报错', { skip, timeout: 60000 }, async () => {
  const b = await openPage('reg-nodata.html', { width: 1200, height: 760, mode: 'map', deliver: false }, 1200);
  try {
    const r = await b.eval(`
      const svg = document.getElementById('canvas');
      svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 300, clientY: 300, bubbles: true, cancelable: true }));
      svg.dispatchEvent(new PointerEvent('pointerdown', { clientX: 300, clientY: 300, bubbles: true }));
      for (const a of ['zoomIn', 'zoomOut', 'compactAll', 'rulesAll', 'hideDone', 'hideDone', 'follow', 'mapMore', 'fit']) document.querySelector('[data-act="' + a + '"]').click();
      window.dispatchEvent(new Event('resize'));
      const before = window.__errors.slice();
      window.__deliver();
      return new Promise(res => setTimeout(() => res({ before, after: window.__errors, cards: document.querySelectorAll('.card').length }), 100));`);
    assert.deepStrictEqual(r.before, [], '数据到达前报错');
    assert.deepStrictEqual(r.after, []);
    assert.strictEqual(r.cards, 9, '数据到达后正常显示');
  } finally { b.close(); }
});

test('规则没有生成时，侧栏和导图顶部都有红色提示', { skip, timeout: 60000 }, async () => {
  const compile = { ok: false, message: '写不进 .claude/rules', time: Date.now() };
  for (const [name, opts, w] of [['reg-compile-side.html', {}, 340], ['reg-compile-map.html', { width: 1200, height: 760, mode: 'map' }, 1200]]) {
    for (const theme of ['dark', 'light']) {
      const b = await openPage(name.replace('.html', `-${theme}.html`), { ...opts, theme, compile }, w);
      try {
        const r = await b.eval(`${CONTRAST}
          const el = [...document.querySelectorAll('.banner.err')].find(e => /规则没有生成/.test(e.textContent));
          return el ? { text: el.textContent, top: el.getBoundingClientRect().top, c: contrast(el.querySelector('span')) } : null;`);
        assert.ok(r, `${name} ${theme}：没有提示`);
        assert.match(r.text, /规则没有生成：写不进 \.claude\/rules/);
        assert.ok(r.top < 120, '提示要在顶部');
        assert.ok(r.c >= 4.5, `对比度 ${r.c.toFixed(2)}`);
      } finally { b.close(); }
    }
  }
  // 编译成功时不显示
  const b = await openPage('reg-compile-ok.html', { compile: { ok: true, message: '', time: Date.now() } }, 340);
  try { assert.strictEqual(await b.eval(`return document.querySelectorAll('.banner.err').length`), 0); } finally { b.close(); }
});

test('共用工具：久未动天数取 data.staleDays，分支颜色用 viewmodel 给的 n.branch', { skip, timeout: 60000 }, async () => {
  const b = await openPage('reg-shared.html', { selId: 'C2.1' }, 340);
  try {
    const r = await b.eval(`
      const D = window.ReqDetail;
      const f = window.__data.files[0];
      const n = { ...f.nodes[0], stale: true };
      const out = {
        five: /但 5 天内 AI 没改过/.test(D.html(f, n, { now: Date.now(), staleDays: 5 })),
        none: /但最近 AI 没改过/.test(D.html(f, n, { now: Date.now() })),
        noHard: !/3 天/.test(D.html(f, n, { now: Date.now(), staleDays: 7 })),
      };
      const rowBranch = () => document.querySelector('.row[data-key$="#C2"]').parentElement.getAttribute('style');
      out.rowBranch = rowBranch();
      // 颜色只认 viewmodel 给的 n.branch：改了它，侧栏跟着变（界面里不再自己算）
      const d = structuredClone(window.__data);
      d.files[0].nodes[0].children.find(n => n.id === 'C2').branch = '--red';
      window.postMessage(d, '*');
      return new Promise(res => setTimeout(() => res({ ...out, rowBranch2: rowBranch() }), 100));`);
    assert.ok(r.five && r.none && r.noHard, JSON.stringify(r));
    assert.match(r.rowBranch, /--branch: var\(--purple\)/);
    assert.match(r.rowBranch2, /--branch: var\(--red\)/);
  } finally { b.close(); }
});

test('导图只画第一棵树，概况和查找也只看第一棵', { skip, timeout: 60000 }, async () => {
  const b = await openPage('reg-files0.html', { width: 1200, height: 760, mode: 'map' }, 1200);
  try {
    const r = await b.eval(`
      const summary = () => document.getElementById('summary').textContent;
      const one = summary();
      const d = structuredClone(window.__data);
      const other = structuredClone(d.files[0]);
      other.uri = 'file:///other.md';
      const rekey = n => { n.key = 'file:///other.md#' + n.id; n.status = 'done'; n.children.forEach(rekey); };
      other.nodes.forEach(rekey);
      d.files.push(other);
      window.postMessage(d, '*');
      return new Promise(res => setTimeout(() => res({ one, two: summary(), cards: document.querySelectorAll('.card').length, errors: window.__errors }), 100));`);
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.cards, 9);
    assert.strictEqual(r.two, r.one, '概况把第二棵树也算进去了');
  } finally { b.close(); }
});

// ---------- 界面打磨（2026-10-22）：圆角变量、按钮、上级规则折叠、聚焦、跟随 AI ----------

// 打开预览页：可以换树、先设「减少动态」再加载
async function openPage2(name, opts, width, { tree = TREE, reduced = false } = {}) {
  fs.mkdirSync(OUT, { recursive: true });
  const treeFile = path.join(OUT, name.replace('.html', '.md'));
  fs.writeFileSync(treeFile, tree);
  const html = path.join(OUT, name);
  fs.writeFileSync(html, build({ treeFile, ...opts }));
  const b = new Browser();
  await b.open(width);
  if (reduced) await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await b.load(html);
  return b;
}
const U = id => 'file:///tree.md#' + id;
// 页面里：把 id 这个需求标成 AI 正在改（其余清掉），推给页面
const ACTIVATE = id => `{ const d = structuredClone(window.__data);
  const walk = ns => ns.forEach(n => { n.active = n.id === '${id}' ? { node: n.id, file: 'x/${id}.html', time: Date.now() } : null; walk(n.children); });
  walk(d.files[0].nodes); window.postMessage(d, '*'); }`;

test('样式：圆角只用变量（--r-card / --r-ctl / --r-pill），导图卡片和胶囊的圆角交给 CSS', () => {
  const dir = path.join(__dirname, '..', 'media');
  const bad = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.css'))) {
    const css = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of css.matchAll(/(border-radius|(?<![-\w])rx)\s*:\s*([^;}]+)/g)) if (!/^((calc\()?var\(--r-(card|ctl|pill)\)|0$)/.test(m[2].trim())) bad.push(`${f}: ${m[0]}`);
  }
  assert.deepStrictEqual(bad, [], '有写死的圆角');
  const root = fs.readFileSync(path.join(dir, 'view.css'), 'utf8');
  for (const t of ['--r-card', '--r-ctl', '--r-pill', '--sp-1', '--sp-2', '--sp-3', '--sp-4']) assert.match(root, new RegExp(`${t}:\\s*\\d`), `没定义 ${t}`);
  // 导图卡片、状态、徽章、规则开关的 <rect> 不再写 rx（图标自己的几何在 detail.js 里，不算）
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'map.js'), 'utf8'), /rx="/);
});

test('详情：没有大按钮，每节「+ 添加」都是同样的链接样式；按钮有焦点环；标题、小标题、内容、说明四级字号和颜色分得开，对比度都够', { skip, timeout: 60000 }, async () => {
  for (const theme of ['dark', 'light']) {
    const b = await openPage2(`polish-btn-${theme}.html`, { theme, selId: 'C2.2' }, 300);
    try {
      // 先按一次 Tab：浏览器只在键盘操作后给 :focus-visible（鼠标点击不显示焦点环）
      await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      const r = await b.eval(`${CONTRAST}
        const css = v => { const e = document.createElement('i'); e.style.color = 'var(' + v + ')'; document.body.appendChild(e); const c = getComputedStyle(e).color; e.remove(); return c; };
        const fs = el => parseFloat(getComputedStyle(el).fontSize);
        const adds = [...document.querySelectorAll('.dp .gh .gh-act')];
        const out = {
          primaries: document.querySelectorAll('.dp .btn:not(.ghost)').length,
          adds: adds.map(a => a.textContent.trim() + '|' + a.dataset.a), addStyle: [...new Set(adds.map(a => getComputedStyle(a).color + getComputedStyle(a).backgroundColor))].length,
          sizes: { title: fs(document.querySelector('.dp .sh-title strong')), gh: fs(document.querySelector('.dp .gh')), rule: fs(document.querySelector('.dp .rule')), gn: fs(document.querySelector('.dp .gh .gn')) },
          colors: { title: getComputedStyle(document.querySelector('.dp .sh-title strong')).color, gh: getComputedStyle(document.querySelector('.dp .gh')).color, rule: getComputedStyle(document.querySelector('.dp .rule .rt')).color },
          ids: [...document.querySelectorAll('.dp .sid, .row .id, .kid-id')].length, crumbs: document.querySelector('.dp .crumbs').textContent,
          seg: [...document.querySelectorAll('.st-btn')].map(e => Math.round(e.getBoundingClientRect().height)),
          focus: css('--vscode-focusBorder'), rings: {}, contrast: {},
        };
        for (const s of ['.dp .lnk', '.st-btn', '.dp .ib', '.inh-tg', '.follow', '.statusbar .ibtn']) {
          const el = document.querySelector(s); if (!el) { out.rings[s] = 'missing'; continue; }
          el.focus(); const cs = getComputedStyle(el);
          out.rings[s] = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 1 && cs.outlineColor === out.focus;
        }
        document.activeElement.blur();
        for (const s of ['.follow', '.inh-tg', '.st-btn .st-l', '.dp .lnk', '.dp .tag', '.dp .gh', '.dp .gh .gn', '.dp .crumbs', '.dp .rule .rt', '.dp .files', '.dp .files .fv', '.kid-t']) { const el = document.querySelector(s); if (el) out.contrast[s] = contrast(el); }
        return out;`);
      assert.strictEqual(r.primaries, 0, `${theme}：详情里不该有大按钮`);
      assert.deepStrictEqual(r.adds, ['添加|addRule', '添加|addChild'], `${theme}：每节的「+ 添加」`);
      assert.strictEqual(r.addStyle, 1, `${theme}：「+ 添加」样式不一致`);
      assert.ok(r.sizes.title >= 18 && r.sizes.gh >= 15 && r.sizes.rule === 13 && r.sizes.gn === 12, `${theme}：字号层级 ${JSON.stringify(r.sizes)}`);
      assert.strictEqual(r.colors.title, r.colors.gh, `${theme}：小标题要和标题一样是正文色`);
      assert.notStrictEqual(r.colors.rule, r.colors.gh, `${theme}：内容要比小标题柔和`);
      assert.strictEqual(r.ids, 0, `${theme}：默认不显示编号`);
      assert.strictEqual(r.crumbs, '示例项目 › 数据科学课', `${theme}：路径只写名字`);
      assert.ok(r.seg.length === 1 && r.seg.every(h => h >= 22), `${theme}：状态按钮太矮或不止一个 ${r.seg}`);
      for (const [s, ok] of Object.entries(r.rings)) assert.strictEqual(ok, true, `${theme}：${s} 没有焦点环`);
      for (const [s, c] of Object.entries(r.contrast)) assert.ok(c >= 4.5, `${theme}：${s} 对比度 ${c.toFixed(2)}`);
    } finally { b.close(); }
  }
});

test('详情：上级规则超过 3 条默认收成一行，回车或点击展开，展开状态记在 webview state；3 条以内直接显示', { skip, timeout: 60000 }, async () => {
  const b = await openPage2('polish-inherit.html', { selId: 'C2.2' }, 340);
  try {
    const before = await b.eval(`
      const tg = document.querySelector('.inh-tg');
      return { text: tg && tg.textContent.replace(/\\s+/g, ''), expanded: tg && tg.getAttribute('aria-expanded'), hidden: document.getElementById('inh-body').hidden,
        own: [...document.querySelectorAll('.dp .rule')].filter(r => r.getClientRects().length).length };`);
    assert.strictEqual(before.text, '继承的规则4');
    assert.strictEqual(before.expanded, 'false');
    assert.strictEqual(before.hidden, true);
    assert.strictEqual(before.own, 2, '自己的规则要一直显示，上级的收起');
    // 键盘：聚焦后按回车
    await b.eval(`document.querySelector('.inh-tg').focus()`);
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const after = await b.eval(`
      const tg = document.querySelector('.inh-tg');
      const out = { expanded: tg.getAttribute('aria-expanded'), hidden: document.getElementById('inh-body').hidden, saved: window.__state && window.__state.inheritOpen,
        visible: [...document.querySelectorAll('.dp .rule')].filter(r => r.getClientRects().length).length };
      // 换一个需求：还是展开的；再点一下收起
      document.querySelector('.row[data-key$="#C2.1"]').click();
      out.keep = document.querySelector('.inh-tg').getAttribute('aria-expanded');
      document.querySelector('.inh-tg').click();
      out.closed = document.querySelector('.inh-tg').getAttribute('aria-expanded') === 'false' && window.__state.inheritOpen === false;
      // G1.1 只有 3 条上级规则：不折叠
      document.querySelector('.row[data-key$="#G1.1"]').click();
      out.small = { toggle: !!document.querySelector('.inh-tg'), rules: document.querySelectorAll('.dp .rule').length };
      return out;`);
    assert.strictEqual(after.expanded, 'true', '回车没有展开');
    assert.strictEqual(after.hidden, false);
    assert.strictEqual(after.saved, true, '展开状态没记进 webview state');
    assert.strictEqual(after.visible, 6);
    assert.strictEqual(after.keep, 'true', '换需求后展开状态丢了');
    assert.ok(after.closed, '点击没有收起');
    assert.deepStrictEqual(after.small, { toggle: false, rules: 4 });
  } finally { b.close(); }
});

test('详情：被覆盖的上级规则划掉、标出「被本需求覆盖」或「被「某需求」覆盖」，对比度够', { skip, timeout: 60000 }, async () => {
  const tree = `# P 项目
- [段落] 段落不超过 4 行
- [语气] 语气柔和
- 每章有练习
- 每章有小结

## A 第一章
> 文件：a/**
- [段落] 段落可以到 6 行

### A1 开场
- [语气] 开场可以活泼一点
`;
  for (const theme of ['dark', 'light']) {
    const b = await openPage2(`polish-override-${theme}.html`, { theme, selId: 'A', state: { inheritOpen: true } }, 300, { tree });
    try {
      const r = await b.eval(`${CONTRAST}
        const pick = () => [...document.querySelectorAll('.dp .rule.r-overridden')].map(el => {
          const t = el.querySelector('.rt'); return { text: t.textContent, deco: getComputedStyle(t).textDecorationLine, note: el.querySelector('.tag') && el.querySelector('.tag').textContent, tip: el.title, c: contrast(t), cn: contrast(el.querySelector('.tag')) }; });
        const a = pick();
        document.querySelector('.row[data-key$="#A1"]').click();
        return { a, a1: pick(), tg: document.querySelector('.inh-tg') && document.querySelector('.inh-tg').textContent.replace(/\\s+/g, '') };`);
      assert.strictEqual(r.a.length, 1);
      assert.strictEqual(r.a[0].text, '段落不超过 4 行');
      assert.strictEqual(r.a[0].deco, 'line-through');
      assert.strictEqual(r.a[0].note, '被本需求覆盖');
      assert.ok(r.a[0].c >= 4.5 && r.a[0].cn >= 4.5, `${theme}：被覆盖规则对比度 ${r.a[0].c.toFixed(2)} / ${r.a[0].cn.toFixed(2)}`);
      // A1：语气被自己覆盖，段落被上级 A 覆盖
      assert.deepStrictEqual(r.a1.map(x => x.note).sort(), ['被「第一章」覆盖', '被本需求覆盖'].sort());
      assert.strictEqual(r.tg, '继承的规则5', '小标题只写条数，不写几条被覆盖');
      assert.strictEqual(r.a[0].tip, '被本需求覆盖');
    } finally { b.close(); }
  }
});

// 导图里：哪些卡片看得见、聚焦的这一支是否都在画布可见区里、顶部路径、记下的状态
const MAP_VIS = `
  const svgR = document.getElementById('canvas').getBoundingClientRect();
  const vis = el => { const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && +cs.opacity > 0.1; };
  const cards = [...document.querySelectorAll('.card')];
  const bar = document.getElementById('focusbar');
  const st = window.__state || {};
  const S = {
    shown: cards.filter(vis).map(c => c.dataset.key.split('#')[1]).sort(),
    inside: cards.filter(c => c.classList.contains('f-in')).every(c => { const r = c.querySelector('.box').getBoundingClientRect(); return r.left >= svgR.left - 1 && r.top >= svgR.top - 1 && r.right <= svgR.right + 1 && r.bottom <= svgR.bottom + 1; }),
    crumbs: bar.hidden ? null : [...bar.querySelectorAll('.crumb')].map(c => c.textContent),
    focus: st.focus ? st.focus.split('#')[1] : null,
    rl: document.querySelectorAll('.rl').length,
    k: +(document.getElementById('world').getAttribute('transform').match(/scale\\(([\\d.]+)/) || [0, 0])[1],
  };`;
const CLICK = sel => `document.querySelector('${sel}').dispatchEvent(new MouseEvent('click', { bubbles: true }));`;
const DBL = sel => `document.querySelector('${sel}').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));`;

test('导图：双击卡片聚焦这一支（其余隐藏、镜头放大、规则展开、顶部路径），Esc / 显示全部 / 点空白处退出，点路径换一级', { skip, timeout: 90000 }, async () => {
  const b = await openPage2('polish-focus-map.html', { width: 1200, height: 760, mode: 'map' }, 1200);
  try {
    const state = async () => b.eval(`${MAP_VIS} return S;`);
    const all = await state();
    assert.strictEqual(all.shown.length, 9);
    assert.strictEqual(all.crumbs, null, '没聚焦时不显示路径');
    await b.eval(DBL('.card[data-key$="#C2"]'));
    await sleep(700);
    const f = await state();
    assert.deepStrictEqual(f.shown, ['C2', 'C2.1', 'C2.2', 'C2.3', 'P'], '这一支以外的卡片还看得见');
    assert.ok(f.inside, '聚焦的这一支没有完整放进画布');
    assert.ok(f.k > all.k && f.k <= 1.5, `镜头没放大或放得太大：${all.k} → ${f.k}`);
    assert.deepStrictEqual(f.crumbs, ['示例项目', '数据科学课']);
    assert.strictEqual(f.focus, 'C2', '聚焦没记进 webview state');
    assert.ok(f.rl >= 5, '这一支的规则没默认展开');
    // 点路径里的 P：换到 P 这一支（整棵树）
    await b.eval(`document.querySelector('#focusbar .crumb[data-key$="#P"]').click()`);
    await sleep(700);
    const p = await state();
    assert.strictEqual(p.focus, 'P');
    assert.strictEqual(p.shown.length, 9);
    // Esc 退出：全部显示，规则还原成收起
    await b.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(700);
    const esc = await state();
    assert.strictEqual(esc.crumbs, null);
    assert.strictEqual(esc.shown.length, 9);
    assert.strictEqual(esc.rl, 0, '退出聚焦后规则没还原');
    assert.strictEqual(esc.focus, null);
    // 显示全部按钮
    // 详情里的「聚焦这一支」
    await b.eval(CLICK('.card[data-key$="#C2.2"]') + `document.querySelector('#side [data-act="focus"]').click();`);
    await sleep(700);
    assert.deepStrictEqual((await state()).shown, ['C2', 'C2.2', 'P']);
    await b.eval(`document.querySelector('#focusbar [data-act="unfocus"]').click()`);
    await sleep(700);
    assert.strictEqual((await state()).shown.length, 9, '显示全部没有恢复');
    // 点画布空白处
    await b.eval(DBL('.card[data-key$="#G1"]'));
    await sleep(700);
    assert.deepStrictEqual((await state()).shown, ['G1', 'G1.1', 'P']);
    await b.eval(`document.getElementById('canvas').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await sleep(700);
    assert.strictEqual((await state()).shown.length, 9, '点空白处没退出');
    assert.deepStrictEqual(await b.eval(`return window.__errors`), []);
  } finally { b.close(); }
});

test('导图：聚焦的需求被删掉后自动退出；减少动态时镜头直接跳过去、光晕不动', { skip, timeout: 60000 }, async () => {
  const b = await openPage2('polish-focus-gone.html', { width: 1200, height: 760, mode: 'map', activeId: 'C2.1', state: { focus: 'C2' } }, 1200, { reduced: true });
  try {
    const first = await b.eval(`${MAP_VIS} return S;`);
    assert.deepStrictEqual(first.crumbs, ['示例项目', '数据科学课'], '记下的聚焦没恢复');
    const after = await b.eval(`{ const d = structuredClone(window.__data); const root = d.files[0].nodes[0]; root.children = root.children.filter(n => n.id !== 'C2'); window.postMessage(d, '*'); }
      return new Promise(res => setTimeout(() => { ${MAP_VIS} res({ ...S, errors: window.__errors }); }, 100));`);
    assert.strictEqual(after.crumbs, null, '聚焦的需求删掉了还在聚焦');
    assert.strictEqual(after.shown.length, 5);
    assert.deepStrictEqual(after.errors, []);
    // 减少动态：点完马上就是最终位置，之后不再变；光晕、旋转都不动
    await b.send('Runtime.evaluate', { expression: `window.postMessage(window.__data, '*')` });
    await sleep(100);
    const m = await b.eval(`
      ${DBL('.card[data-key$="#C2"]')}
      const t1 = document.getElementById('world').getAttribute('transform');
      return new Promise(res => setTimeout(() => res({ t1, t2: document.getElementById('world').getAttribute('transform'),
        anim: [...document.querySelectorAll('.st-doing, .halo')].map(e => getComputedStyle(e).animationName) }), 600));`);
    assert.strictEqual(m.t1, m.t2, '减少动态时镜头还在动画');
    assert.ok(m.anim.length && m.anim.every(a => a === 'none'), `减少动态时还有动画：${m.anim}`);
  } finally { b.close(); }
});

test('侧栏：只看这一支（路径 + 子树、详情变高），Esc / 显示全部 / 点空白处 / 点路径都能用，状态记住', { skip, timeout: 60000 }, async () => {
  const b = await openPage2('polish-focus-side.html', { selId: 'C2', height: 700 }, 300);
  try {
    const r = await b.eval(`
      const rows = () => [...document.querySelectorAll('.row')].map(r => r.dataset.key.split('#')[1] + (r.classList.contains('anc') ? '^' : ''));
      const detailH = () => document.querySelector('.detail').getBoundingClientRect().height;
      const out = { before: rows(), h0: detailH() };
      document.querySelector('.dp [data-act="focus"]').click();
      out.focused = rows(); out.h1 = detailH(); out.saved = window.__state.focus;
      out.crumbs = [...document.querySelectorAll('.focusbar .crumb')].map(c => c.textContent);
      out.noBtn = !document.querySelector('.dp [data-act="focus"]');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      out.esc = rows().length; out.savedEsc = window.__state.focus;
      document.querySelector('.dp [data-act="focus"]').click();
      document.querySelector('.focusbar [data-act="unfocus"]').click();
      out.unfocus = rows().length;
      document.querySelector('.dp [data-act="focus"]').click();
      document.querySelector('.tree').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      out.blank = rows().length;
      // 选 C2.2 再聚焦，点路径里的 C2 换到 C2 这一支
      document.querySelector('.row[data-key$="#C2.2"]').click();
      document.querySelector('.dp [data-act="focus"]').click();
      out.deep = rows();
      document.querySelector('.focusbar .crumb[data-key$="#C2"]').click();
      out.crumb = rows();
      // 点路标行（上级 P）：换到 P 这一支
      document.querySelector('.row.anc').click();
      out.anc = rows().length;
      out.errors = window.__errors;
      return out;`);
    assert.strictEqual(r.before.length, 9);
    assert.deepStrictEqual(r.focused, ['P^', 'C2', 'C2.1', 'C2.2', 'C2.3'], '只看这一支后还显示别的分支');
    assert.ok(r.h1 > r.h0, `详情没有变高：${r.h0} → ${r.h1}`);
    assert.strictEqual(r.saved, U('C2'));
    assert.deepStrictEqual(r.crumbs, ['示例项目', '数据科学课']);
    assert.ok(r.noBtn, '已经在看这一支时不该再显示按钮');
    assert.strictEqual(r.esc, 9); assert.strictEqual(r.savedEsc, null);
    assert.strictEqual(r.unfocus, 9);
    assert.strictEqual(r.blank, 9, '点空白处没退出');
    assert.deepStrictEqual(r.deep, ['P^', 'C2^', 'C2.2']);
    assert.deepStrictEqual(r.crumb, ['P^', 'C2', 'C2.1', 'C2.2', 'C2.3']);
    assert.strictEqual(r.anc, 9);
    assert.deepStrictEqual(r.errors, []);
  } finally { b.close(); }
  // 刷新后还记得；聚焦的需求不存在了就自动退出
  for (const [focus, want] of [['C2', 5], ['C9', 9]]) {
    const b2 = await openPage2(`polish-focus-side-${focus}.html`, { selId: 'C2', state: { focus } }, 300);
    try { assert.strictEqual(await b2.eval(`return document.querySelectorAll('.row').length`), want, `focus=${focus}`); } finally { b2.close(); }
  }
});

test('跟随 AI（侧栏）：自动展开、滚进视野、闪一下；不改选中；输入框有焦点时不跳；开关记住；减少动态时直接跳', { skip, timeout: 90000 }, async () => {
  // 侧栏矮一点，树滚得动；C2 先折叠，C2.3 藏在里面
  const opts = { selId: 'G1', height: 330, state: { collapsed: [U('C2')], detailHeight: 120 } };
  const inView = id => `(() => { const row = document.querySelector('.row[data-key$="#${id}"]'); if (!row) return false; const r = row.getBoundingClientRect(), t = document.querySelector('.tree').getBoundingClientRect(); return r.top >= t.top - 1 && r.bottom <= t.bottom + 1; })()`;
  for (const reduced of [false, true]) {
    const b = await openPage2(`polish-follow-${reduced ? 'reduced' : 'smooth'}.html`, opts, 300, { reduced });
    try {
      const r = await b.eval(`
        const out = { follow: document.querySelector('.follow').getAttribute('aria-pressed') };
        document.querySelector('.tree').scrollTop = 0;
        ${ACTIVATE('C2.3')}
        return new Promise(res => setTimeout(() => {
          const row = document.querySelector('.row[data-key$="#C2.3"]');
          res({ ...out, expanded: !!row, flash: !!(row && row.classList.contains('flash')), aiOn: !!(row && row.classList.contains('ai-on')),
            quick: ${inView('C2.3')}, sel: window.__state ? window.__state.selected.split('#')[1] : 'G1',
            anim: row ? getComputedStyle(row).animationName : '' });
        }, 60));`);
      assert.strictEqual(r.follow, 'true', '跟随 AI 默认要开');
      assert.ok(r.expanded, '没有展开 AI 在改的需求的上级');
      assert.ok(r.flash && r.aiOn, '没有闪一下 / 没有 AI 正在改的样式');
      assert.strictEqual(r.sel, 'G1', '跟随 AI 不能改用户选中的需求');
      if (reduced) {
        assert.ok(r.quick, '减少动态时应该直接跳到那一行');
        assert.strictEqual(r.anim, 'none', '减少动态时还有动画');
      } else {
        await sleep(900);
        assert.ok(await b.eval(`return ${inView('C2.3')}`), '没有滚到 AI 在改的那一行');
      }
      // 输入框有焦点：不跳
      const busy = await b.eval(`
        const input = document.createElement('input'); document.body.appendChild(input); input.focus();
        document.querySelector('.tree').scrollTop = 0;
        ${ACTIVATE('C4')}
        return new Promise(res => setTimeout(() => { const out = { scroll: document.querySelector('.tree').scrollTop, flash: !!document.querySelector('.row.flash[data-key$="#C4"]') }; input.remove(); res(out); }, 900));`);
      assert.deepStrictEqual(busy, { scroll: 0, flash: false }, '用户在输入时跳走了');
      // 关掉开关：记进 state，之后不再跟随
      const off = await b.eval(`
        document.querySelector('.follow').click();
        const saved = window.__state.follow;
        ${ACTIVATE('G1.1')}
        return new Promise(res => setTimeout(() => res({ saved, pressed: document.querySelector('.follow').getAttribute('aria-pressed'), flash: !!document.querySelector('.row.flash') }), 100));`);
      assert.deepStrictEqual(off, { saved: false, pressed: 'false', flash: false });
    } finally { b.close(); }
  }
  // 开关关着刷新：还是关着
  const b = await openPage2('polish-follow-off.html', { ...opts, state: { ...opts.state, follow: false } }, 300);
  try { assert.strictEqual(await b.eval(`return document.querySelector('.follow').getAttribute('aria-pressed')`), 'false'); } finally { b.close(); }
});

test('跟随 AI（导图）：AI 改的卡片不在视野里时平移进来、闪一下、有光晕；开关记住', { skip, timeout: 60000 }, async () => {
  const b = await openPage2('polish-follow-map.html', { width: 1200, height: 760, mode: 'map', state: { view: { x: 0, y: 0, k: 2.4 } } }, 1200);
  try {
    const box = `(() => { const s = document.getElementById('canvas').getBoundingClientRect(), c = document.querySelector('.card[data-key$="#C4"] .box').getBoundingClientRect(); return c.left >= s.left && c.top >= s.top && c.right <= s.right && c.bottom <= s.bottom; })()`;
    const r = await b.eval(`
      const before = ${box};
      ${ACTIVATE('C4')}
      return new Promise(res => setTimeout(() => res({ before, after: ${box}, flash: !!document.querySelector('.card.flash[data-key$="#C4"]'), halo: !!document.querySelector('.card[data-key$="#C4"] .halo'), errors: window.__errors }), 800));`);
    assert.strictEqual(r.before, false, '测试前提：C4 一开始不在视野里');
    assert.ok(r.after, '没有把 AI 在改的卡片移进视野');
    assert.ok(r.flash && r.halo, '没有闪一下 / 没有光晕');
    assert.deepStrictEqual(r.errors, []);
    const t = await b.eval(`document.querySelector('.toolbar [data-act="follow"]').click(); return [window.__state.follow, document.querySelector('.toolbar [data-act="follow"]').getAttribute('aria-pressed')];`);
    assert.deepStrictEqual(t, [false, 'false']);
  } finally { b.close(); }
});

test('样式：颜色只在 view.css 开头的变量块里定义，别处没有写死的十六进制或 rgb 颜色', () => {
  const dir = path.join(__dirname, '..', 'media');
  const bad = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.css'))) {
    let css = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    // view.css 开头的 :root { … } 是唯一的颜色定义处
    if (f === 'view.css') css = css.replace(/^\s*:root\s*\{[\s\S]*?\n\}/, '');
    for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)) bad.push(`${f}: ${css.slice(Math.max(0, m.index - 30), m.index + 12).replace(/\s+/g, ' ')}`);
  }
  assert.deepStrictEqual(bad, [], '有写死的颜色');
  // 媒体脚本里也不写颜色（画 SVG 的颜色一律走 CSS）
  for (const f of ['map.js', 'view.js', 'detail.js']) assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /#[0-9a-fA-F]{6}\b|\brgba?\(/, f);
});

test('导图：每张卡片的「› 2 条」单独展开收起，不受工具栏默认影响；键盘也能操作；记在 state 里', { skip, timeout: 60000 }, async () => {
  const b = await openPage2('polish-cardtoggle.html', { width: 1200, height: 760, mode: 'map' }, 1200);
  try {
    const open = id => `document.querySelector('.card[data-key$="#${id}"]').classList.contains('open')`;
    const r = await b.eval(`
      const out = { start: [${open('C2.2')}, ${open('C2')}], pressed: document.querySelector('[data-act="compactAll"]').getAttribute('aria-pressed') };
      document.querySelector('[data-rules$="#C2.2"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      out.one = [${open('C2.2')}, ${open('C2')}, document.querySelector('[data-rules$="#C2.2"]').getAttribute('aria-expanded')];
      // 工具栏切到「显示规则」：别的卡片都展开；再切回「只看标题」：C2.2 自己点开过，保持展开
      document.querySelector('[data-act="rulesAll"]').click();
      out.all = [${open('C2.2')}, ${open('C2')}, document.querySelector('[data-act="rulesAll"]').getAttribute('aria-pressed')];
      document.querySelector('[data-rules$="#C2"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); // 在「显示规则」下单独收起 C2
      document.querySelector('[data-act="compactAll"]').click();
      out.back = [${open('C2.2')}, ${open('C2')}, ${open('G1')}];
      document.querySelector('[data-act="rulesAll"]').click();
      out.again = [${open('C2')}, ${open('G1')}];
      out.saved = window.__state.cardOpen;
      document.querySelector('[data-rules$="#G1"]').focus();
      return out;`);
    assert.deepStrictEqual(r.start, [false, false], '默认只看标题');
    assert.strictEqual(r.pressed, 'true');
    assert.deepStrictEqual(r.one, [true, false, 'true'], '只展开点的那一张');
    assert.deepStrictEqual(r.all, [true, true, 'true']);
    assert.deepStrictEqual(r.back, [true, false, false], '工具栏改默认时，自己点过的卡片保持自己的状态');
    assert.deepStrictEqual(r.again, [false, true], '在「显示规则」下单独收起的卡片，切回来还是收起');
    assert.deepStrictEqual(r.saved, { [U('C2.2')]: true, [U('C2')]: false });
    // 键盘：焦点在 G1 的开关上按回车
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    assert.strictEqual(await b.eval(`return [${open('G1')}, document.activeElement.dataset.rules.split('#')[1]].join()`), 'false,G1', '回车没切换，或焦点丢了');
    // 刷新后还记得每张卡片自己的状态
    const b2 = await openPage2('polish-cardtoggle2.html', { width: 1200, height: 760, mode: 'map', state: { cardOpen: { [U('C2.2')]: true } } }, 1200);
    try { assert.strictEqual(await b2.eval(`return ${open('C2.2')} && !${open('C2.1')}`), true); } finally { b2.close(); }
  } finally { b.close(); }
});

test('导图：单击卡片选中，不在这一支的卡片和连线变淡（还能点）；Esc / 点空白处恢复；点变淡的卡片换选中', { skip, timeout: 60000 }, async () => {
  const b = await openPage2('polish-dim.html', { width: 1200, height: 760, mode: 'map' }, 1200);
  try {
    const DIM = `
      const op = el => +getComputedStyle(el).opacity;
      const S = { dimCards: [...document.querySelectorAll('.card.dim')].map(c => c.dataset.key.split('#')[1]).sort(),
        dimLinks: document.querySelectorAll('.link.dim').length, links: document.querySelectorAll('.link').length,
        sel: (document.querySelector('.card.sel') || { dataset: { key: '#' } }).dataset.key.split('#')[1],
        side: document.querySelector('#side .sh-title strong')?.textContent, crumbs: document.getElementById('focusbar').hidden };`;
    const click = sel => `document.querySelector('${sel}').dispatchEvent(new MouseEvent('click', { bubbles: true }));`;
    const r1 = await b.eval(`${click('.card[data-key$="#C2.2"]')} return new Promise(res => setTimeout(() => { ${DIM} res({ ...S, opacity: op(document.querySelector('.card.dim')), selOp: op(document.querySelector('.card.sel')) }); }, 450));`);
    assert.deepStrictEqual(r1.dimCards, ['C2.1', 'C2.3', 'C3', 'C4', 'G1', 'G1.1'], '不在这一支的卡片要变淡');
    assert.ok(r1.opacity > 0.25 && r1.opacity < 0.45, `变淡的透明度 ${r1.opacity}`);
    assert.strictEqual(r1.selOp, 1);
    assert.strictEqual(r1.dimLinks, r1.links - 2, '只有 P→C2→C2.2 两根连线不变淡');
    assert.strictEqual(r1.sel, 'C2.2'); assert.strictEqual(r1.side, '英文版');
    assert.strictEqual(r1.crumbs, true, '单击不该进入聚焦');
    // 点变淡的卡片：换选中、换高亮
    const r2 = await b.eval(`${click('.card[data-key$="#G1.1"]')} ${DIM} return S;`);
    assert.strictEqual(r2.sel, 'G1.1');
    assert.deepStrictEqual(r2.dimCards, ['C2', 'C2.1', 'C2.2', 'C2.3', 'C3', 'C4']);
    // Esc 恢复（选中不变）
    const r3 = await b.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); ${DIM} return S;`);
    assert.deepStrictEqual(r3.dimCards, []); assert.strictEqual(r3.dimLinks, 0); assert.strictEqual(r3.sel, 'G1.1');
    // 点空白处恢复
    const r4 = await b.eval(`${click('.card[data-key$="#C3"]')} const before = document.querySelectorAll('.card.dim').length;
      document.getElementById('canvas').dispatchEvent(new MouseEvent('click', { bubbles: true })); ${DIM} return { before, ...S, errors: window.__errors };`);
    assert.ok(r4.before > 0);
    assert.deepStrictEqual(r4.dimCards, []);
    assert.deepStrictEqual(r4.errors, []);
  } finally { b.close(); }
  // 减少动态：直接变，没有过渡
  const b2 = await openPage2('polish-dim-reduced.html', { width: 1200, height: 760, mode: 'map' }, 1200, { reduced: true });
  try {
    const t = await b2.eval(`document.querySelector('.card[data-key$="#C2.2"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const c = document.querySelector('.card.dim'); return [getComputedStyle(c).transitionDuration, +getComputedStyle(c).opacity];`);
    assert.strictEqual(t[0], '0s');
    assert.ok(t[1] < 0.45);
  } finally { b2.close(); }
});

test('侧栏：选中一行后不在这一支的行变淡（约 55%）；Esc / 点树的空白处恢复', { skip, timeout: 60000 }, async () => {
  const b = await openPage2('polish-dim-side.html', { width: 320 }, 320);
  try {
    const r = await b.eval(`
      const dims = () => [...document.querySelectorAll('.row.dim')].map(r => r.dataset.key.split('#')[1]).sort();
      const out = { start: dims() };
      document.querySelector('.row[data-key$="#C2"]').click();
      out.sel = dims(); out.op = +getComputedStyle(document.querySelector('.row.dim')).opacity;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      out.esc = dims(); out.stillSel = document.querySelector('.row.sel').dataset.key.split('#')[1];
      document.querySelector('.row[data-key$="#G1.1"]').click();
      out.g = dims();
      document.querySelector('.tree').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      out.blank = dims();
      return out;`);
    assert.deepStrictEqual(r.start, [], '刚打开不变淡');
    assert.deepStrictEqual(r.sel, ['C3', 'C4', 'G1', 'G1.1']);
    assert.ok(r.op > 0.45 && r.op < 0.65, `变淡的透明度 ${r.op}`);
    assert.deepStrictEqual(r.esc, []); assert.strictEqual(r.stillSel, 'C2');
    assert.deepStrictEqual(r.g, ['C2', 'C2.1', 'C2.2', 'C2.3', 'C3', 'C4']);
    assert.deepStrictEqual(r.blank, []);
  } finally { b.close(); }
});

test('编号默认不显示：标题悬停提示里有编号，⋯ 菜单能复制编号，设置里打开「显示编号」后侧栏、详情、导图都显示', { skip, timeout: 60000 }, async () => {
  const b = await openPage2('polish-ids.html', { selId: 'C2.2' }, 320);
  try {
    const r = await b.eval(`
      const count = () => document.querySelectorAll('.row .id, .dp .sid').length;
      const out = { before: count(), tip: document.querySelector('.dp .sh-title strong').title };
      document.querySelector('.dp [data-act="more"]').click();
      out.menu = [...document.querySelectorAll('.menu button')].map(x => x.textContent);
      document.querySelector('.dp [data-act="more"]').click();
      document.querySelector('.gear[data-act="settings"]').click();
      const t = [...document.querySelectorAll('.menu button')].find(x => x.textContent.includes('显示编号'));
      out.role = t.getAttribute('role') + ':' + t.getAttribute('aria-checked');
      t.click();
      out.after = count(); out.saved = window.__state.showIds;
      out.crumbs = document.querySelector('.dp .crumbs').textContent;
      return out;`);
    assert.strictEqual(r.before, 0);
    assert.match(r.tip, /^C2\.2/);
    assert.ok(r.menu.some(x => /复制编号 C2\.2/.test(x)), r.menu.join());
    assert.ok(r.menu.some(x => /复制规则/.test(x)) && r.menu.some(x => /删除需求/.test(x)) && r.menu.some(x => /打开原文/.test(x)));
    assert.strictEqual(r.role, 'menuitemcheckbox:false');
    assert.ok(r.after >= 10, `打开后应该显示编号：${r.after}`);
    assert.strictEqual(r.saved, true);
    assert.strictEqual(r.crumbs, 'P 示例项目 › C2 数据科学课');
  } finally { b.close(); }
  const m = await openPage2('polish-ids-map.html', { width: 1200, height: 760, mode: 'map', state: { showIds: false } }, 1200);
  try {
    assert.strictEqual(await m.eval(`return document.querySelectorAll('.cid').length`), 0);
    const on = await m.eval(`document.querySelector('[data-act="mapMore"]').click();
      [...document.querySelectorAll('.menu button')].find(x => x.textContent.includes('显示编号')).click();
      return document.querySelectorAll('.cid').length;`);
    assert.strictEqual(on, 9);
  } finally { m.close(); }
});

test('详情：点标题在面板里直接改名——回车保存、Esc 取消、点别处保存、空名字不收；改名时数据推过来也不冲掉输入框', { skip, timeout: 60000 }, async () => {
  const b = await openPage2('polish-rename.html', { selId: 'C2.2' }, 320);
  try {
    const r = await b.eval(`
      const posted = () => window.__posted.filter(m => m.action === 'rename');
      const title = () => document.querySelector('.dp .sh-title strong');
      const input = () => document.querySelector('.dp .title-in');
      const out = {};
      title().click();
      out.opened = !!input() && document.activeElement === input() && input().value === '英文版';
      // 编辑中推来新数据：不重画
      window.postMessage(window.__data, '*');
      return new Promise(res => setTimeout(() => { try {
      out.kept = !!input();
      // 空名字回车：不收，输入框还在、标红
      input().value = '   ';
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      out.empty = { still: !!input(), invalid: input().getAttribute('aria-invalid'), sent: posted().length };
      // Esc：取消，不发；也不退出别的状态
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      out.esc = { closed: !input(), title: title().textContent, sent: posted().length };
      // 回车保存
      document.querySelector('.dp .pen').click();
      input().value = ' 英文版（澳式） ';
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      out.enter = { closed: !input(), msg: posted().pop() };
      // 点别处（失去焦点）保存
      title().click();
      input().value = '英文版 2';
      input().dispatchEvent(new FocusEvent('blur')); // 无头浏览器的页面没有焦点，blur() 不触发事件，直接发
      out.blur = posted().pop();
      // 名字没变：不发
      const n = posted().length;
      title().click(); input().dispatchEvent(new FocusEvent('blur'));
      out.same = posted().length === n;
      out.errors = window.__errors;
      res(out);
      } catch (e) { res({ error: e.message }); } }, 50));`);
    assert.ok(r.opened, '点标题没有变成输入框');
    assert.ok(r.kept, '改名时推来数据把输入框冲掉了');
    assert.deepStrictEqual(r.empty, { still: true, invalid: 'true', sent: 0 });
    assert.deepStrictEqual(r.esc, { closed: true, title: '英文版', sent: 0 });
    assert.ok(r.enter.closed);
    assert.deepStrictEqual({ ...r.enter.msg }, { type: 'edit', uri: 'file:///tree.md', action: 'rename', node: 'C2.2', title: '英文版（澳式）' });
    assert.strictEqual(r.blur.title, '英文版 2');
    assert.ok(r.same);
    assert.deepStrictEqual(r.errors, []);
  } finally { b.close(); }
});

test('上下文用量：⚙ 和导图 ⋯ 里能打开；会话可以切；常驻 / 按需的横条和数字；文件列表常驻在前、按字数排；需求的规则能点过去；没数据时有说明', { skip, timeout: 90000 }, async () => {
  const { fakeContext } = require('../tools/preview');
  const tree = fs.readFileSync(path.join(__dirname, '..', 'example', '需求树.md'), 'utf8');
  for (const theme of ['dark', 'light']) {
    const b = await openPage2(`polish-ctx-${theme}.html`, { theme, selId: 'R3.2', context: fakeContext }, 320, { tree });
    try {
      const r = await b.eval(`${CONTRAST}
        document.querySelector('.gear[data-act="settings"]').click();
        [...document.querySelectorAll('.menu button')].find(x => x.textContent.includes('上下文用量')).click();
        const box = document.querySelector('.ctx');
        const rows = () => [...box.querySelectorAll('.ctx-row')].map(r => ({ kind: r.classList.contains('ctx-resident') ? 'r' : 'd', name: r.querySelector('.ctx-main > :first-child').textContent, chars: +r.querySelector('.ctx-chars').textContent.replace(/[^0-9]/g, ''), why: r.querySelector('.ctx-why').textContent }));
        const out = { dialog: box.getAttribute('role'), options: [...box.querySelectorAll('select option')].map(o => o.textContent),
          nums: box.querySelector('.ctx-nums').textContent.replace(/\s+/g, ' ').trim(), bar: box.querySelector('.ctx-bar').getAttribute('aria-label'), rows: rows(),
          widths: [...box.querySelectorAll('.ctx-bar span')].map(s => parseFloat(s.style.width)) };
        out.contrast = Math.min(...[...box.querySelectorAll('.ctx-why, .ctx-chars, .ctx-name, .ctx-sub, .ctx-nums, .ctx-node')].map(contrast));
        // 切到第二个会话
        const sel = box.querySelector('select'); sel.value = '1'; sel.dispatchEvent(new Event('change', { bubbles: true }));
        out.second = document.querySelector('.ctx-nums').textContent.replace(/\s+/g, ' ').trim();
        // 点需求的规则：关掉浮层，选中那个需求
        const sel2 = document.querySelector('.ctx select'); sel2.value = '0'; sel2.dispatchEvent(new Event('change', { bubbles: true }));
        [...document.querySelectorAll('.ctx-node')].find(x => x.textContent.includes('第1章')).click();
        out.after = { open: !!document.querySelector('.ctx-ov'), title: document.querySelector('.dp .sh-title strong').textContent };
        // Esc 关闭（不影响别的）
        document.querySelector('.gear[data-act="settings"]').click();
        [...document.querySelectorAll('.menu button')].find(x => x.textContent.includes('上下文用量')).click();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        out.esc = !document.querySelector('.ctx-ov');
        out.errors = window.__errors;
        return out;`);
      assert.strictEqual(r.dialog, 'dialog');
      assert.strictEqual(r.options.length, 2);
      assert.match(r.options[0], /开始 · 2 个 agent$/);
      assert.strictEqual(r.nums, '常驻 11,230 字 · 按需 1,175 字');
      assert.match(r.bar, /常驻 11,230 字，按需 1,175 字/);
      assert.ok(Math.abs(r.widths[0] - 90.5) < 0.5 && Math.abs(r.widths[1] - 9.5) < 0.5, `横条比例 ${r.widths}`);
      const kinds = r.rows.map(x => x.kind).join('');
      assert.strictEqual(kinds, 'rrrrddd', '常驻在前');
      for (const k of ['r', 'd']) { const c = r.rows.filter(x => x.kind === k).map(x => x.chars); assert.deepStrictEqual(c, [...c].sort((a, b) => b - a), '按字数从多到少'); }
      assert.strictEqual(r.rows[0].name, 'CLAUDE.md'); assert.strictEqual(r.rows[0].why, '每个会话都带着');
      const ch1 = r.rows.find(x => x.name === '规则：第1章');
      assert.match(ch1.why, /^读 ch01-cholera\.html 时加载/);
      assert.ok(r.contrast >= 4.5, `${theme}：上下文用量文字对比度 ${r.contrast.toFixed(2)}`);
      assert.strictEqual(r.second, '常驻 9,500 字 · 按需 210 字');
      assert.deepStrictEqual(r.after, { open: false, title: '第1章' });
      assert.ok(r.esc);
      assert.deepStrictEqual(r.errors, []);
    } finally { b.close(); }
  }
  // 没数据：说明怎么才有
  const e = await openPage2('polish-ctx-empty.html', { width: 1200, height: 760, mode: 'map' }, 1200, { tree });
  try {
    const t = await e.eval(`document.querySelector('[data-act="mapMore"]').click();
      [...document.querySelectorAll('.menu button')].find(x => x.textContent.includes('上下文用量')).click();
      return document.querySelector('.ctx-empty')?.textContent;`);
    assert.strictEqual(t, '新开一个会话后，这里会显示 AI 加载了哪些规则');
  } finally { e.close(); }
});

test('文字表：中英文两张表的键一样、类型一样；代码里用到的键都在表里', () => {
  const S = require('../media/strings');
  assert.deepStrictEqual(Object.keys(S.en).sort(), Object.keys(S.zh).sort(), '两张表的键不一样');
  for (const k of Object.keys(S.zh)) assert.strictEqual(typeof S.en[k], typeof S.zh[k], `${k} 一个是函数一个不是`);
  const root = path.join(__dirname, '..');
  const used = new Set();
  for (const f of ['media/detail.js', 'media/view.js', 'media/map.js', 'extension.js']) {
    for (const m of fs.readFileSync(path.join(root, f), 'utf8').matchAll(/\bT\('([\w.]+)'/g)) used.add(m[1]);
  }
  for (const m of fs.readFileSync(path.join(root, 'media/map-body.js'), 'utf8').matchAll(/data-t(?:-short|-title|-aria)?="([\w.]+)"/g)) used.add(m[1]);
  assert.ok(used.size > 80, `找到的键太少：${used.size}`);
  assert.deepStrictEqual([...used].filter(k => !(k in S.zh)), [], '用到了表里没有的键');
  // 语言选择：设置优先，auto 跟 VS Code 的显示语言
  assert.strictEqual(S.pick('auto', 'en-US'), 'en');
  assert.strictEqual(S.pick('auto', 'zh-cn'), 'zh');
  assert.strictEqual(S.pick('zh', 'en'), 'zh');
  assert.strictEqual(S.pick('en', 'zh-cn'), 'en');
  // package.json 的标题走 package.nls*.json，两份键一样
  const pkg = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const nlsEn = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
  const nlsZh = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.zh-cn.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(nlsEn).sort(), Object.keys(nlsZh).sort());
  for (const m of pkg.matchAll(/"%([\w.]+)%"/g)) assert.ok(m[1] in nlsEn, `package.nls.json 里没有 ${m[1]}`);
  assert.doesNotMatch(pkg.replace(/"workspaceContains:[^"]*"/g, ''), /[一-鿿]/, 'package.json 里还有中文（应该写在 package.nls.zh-cn.json；激活条件里的文件名除外）');
});

test('英文界面：侧栏、详情、导图、菜单、上下文用量里都没有中文（树的内容也是英文）', { skip, timeout: 90000 }, async () => {
  const { fakeContext } = require('../tools/preview');
  const tree = fs.readFileSync(path.join(__dirname, '..', 'example', 'en', 'course.tree.md'), 'utf8');
  const SCAN = `
    const CJK = /[\u4e00-\u9fff]/;
    const bad = [];
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t; (t = tw.nextNode());) { if (/^(SCRIPT|STYLE)$/.test(t.parentNode.nodeName)) continue; if (CJK.test(t.nodeValue)) bad.push(t.nodeValue.trim().slice(0, 40)); }
    for (const el of document.querySelectorAll('[title], [aria-label], [placeholder]'))
      for (const a of ['title', 'aria-label', 'placeholder']) if (CJK.test(el.getAttribute(a) || '')) bad.push(a + '=' + el.getAttribute(a).slice(0, 40));`;
  for (const [name, opts, w] of [
    ['en-side.html', { selId: 'R3.2', activeId: 'R3.1', sinceDays: 10, state: { inheritOpen: true } }, 320],
    ['en-map.html', { selId: 'R3.2', activeId: 'R3.1', sinceDays: 10, width: 1300, height: 800, mode: 'map', state: { defaultOpen: true, inheritOpen: true } }, 1300],
  ]) {
    const b = await openPage2(name, { ...opts, lang: 'en', context: fakeContext }, w, { tree });
    try {
      const r = await b.eval(`${SCAN}
        const out = { page: bad.slice(), lang: document.documentElement.lang, title: document.querySelector('.dp .sh-title strong').textContent };
        // 菜单和上下文用量也查
        const opener = document.querySelector('.gear[data-act="settings"]') || document.querySelector('[data-act="mapMore"]');
        opener.click();
        out.menu = [...document.querySelectorAll('.menu button')].map(x => x.textContent);
        [...document.querySelectorAll('.menu button')].find(x => /Context usage/.test(x.textContent)).click();
        out.ctx = document.querySelector('.ctx-nums').textContent.replace(/\\s+/g, ' ').trim();
        { ${SCAN} out.withCtx = bad; }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        document.querySelector('.dp [data-act="more"]').click();
        out.more = [...document.querySelectorAll('.menu button')].map(x => x.textContent);
        out.errors = window.__errors;
        return out;`);
      assert.deepStrictEqual(r.errors, [], name);
      assert.strictEqual(r.lang, 'en');
      assert.strictEqual(r.title, 'Opening story');
      assert.deepStrictEqual(r.page, [], `${name}：页面上还有中文`);
      assert.deepStrictEqual(r.withCtx, [], `${name}：上下文用量里还有中文`);
      assert.ok(r.menu.some(x => x.includes('Show IDs')), r.menu.join());
      assert.strictEqual(r.ctx, 'Always loaded 11,230 chars · On demand 1,175 chars');
      assert.deepStrictEqual(r.more, ['Copy rules (to paste to the AI)', 'Copy ID R3.2', 'Open in editor', 'Delete requirement…']);
    } finally { b.close(); }
  }
});

test('导图变窄：工具栏到 700px 还是一行；自动适应不小于 0.85 倍；详情在下面且没选中时收成一行；没选中时「新需求」和说明隔开', { skip, timeout: 90000 }, async () => {
  for (const w of [700, 940]) {
    const b = await openPage2(`narrow-${w}.html`, { width: w, height: 800, mode: 'map' }, w);
    try {
      const r = await b.eval(`
        const tb = document.querySelector('.toolbar').getBoundingClientRect();
        const btns = [...document.querySelectorAll('.toolbar > *')].filter(e => e.getClientRects().length).map(e => { const r = e.getBoundingClientRect(); return Math.round((r.top + r.bottom) / 2 / 4); });
        const k = +document.getElementById('world').getAttribute('transform').match(/scale\\(([\\d.]+)/)[1];
        const side = document.getElementById('side').getBoundingClientRect();
        const hint = document.querySelector('#side .dp-empty .empty').getBoundingClientRect(), btn = document.querySelector('#side .new-btn').getBoundingClientRect();
        return { rows: new Set(btns).size, tbH: tb.height, k, sideH: side.height, stacked: side.top > tb.bottom + 100, gap: btn.top - hint.bottom, inline: Math.abs(btn.top - hint.top) < 12 };`);
      assert.strictEqual(r.rows, 1, `${w}px：工具栏折成了 ${r.rows} 行`);
      assert.ok(r.k >= 0.85 - 1e-6, `${w}px：自动缩到 ${r.k}`);
      if (r.stacked) { assert.ok(r.sideH <= 56, `${w}px：没选中时下面的详情应该收成一行，现在 ${r.sideH}px`); assert.ok(r.inline); }
      else assert.ok(r.gap >= 11.5, `${w}px：「新需求」和说明贴在一起（${r.gap}px）`);
    } finally { b.close(); }
  }
});

test('英文界面：新的改动记录、记录员状态、出错提示都按英文显示（没有中文）；旧记录（只有存下的文字）照样显示', { skip, timeout: 90000 }, async () => {
  const tree = fs.readFileSync(path.join(__dirname, '..', 'example', 'en', 'course.tree.md'), 'utf8');
  const now = Date.now();
  // 新记录：带 ops（结构化），summary 是中文；旧记录：只有中文 summary、ops 认不出
  const changes = [
    { id: 'n1', time: now - 60000, source: '记录员', summary: ['给 R3.2 加规则「x」', 'R3.2 标为正在做'], undone: false,
      ops: [{ op: 'add_rule', node: 'R3.2', text: 'Suspense within the first screen', undo: [{ op: 'remove_rule', node: 'R3.2', text: 'Suspense within the first screen' }] },
            { op: 'set_status', node: 'R3.2', status: 'doing', undo: [{ op: 'set_status', node: 'R3.2', status: null }] }] },
    { id: 'n2', time: now - 120000, source: '你', summary: ['R4 改名为「第2章」'], undone: false,
      ops: [{ op: 'rename_node', node: 'R4', title: 'Chapter 2', undo: [{ op: 'rename_node', node: 'R4', title: 'Chapter Two' }] },
            { op: 'delete_node', node: 'R9', undo: [{ op: 'restore_node', parent: 'P', before: null, at: 30, lines: ['## R9 Old idea ⏳', '- something'] }] }] },
    { id: 'n3', time: now - 180000, source: '升级', summary: ['清掉旧版本留下的待确认标记（3 处）'], event: { k: 'chg.legacy', a: [3] }, undone: false, ops: [] },
    { id: 'old', time: now - 240000, source: '记录员', summary: ['old entry kept as stored'], undone: false, ops: [{ op: 'reject_pending', node: 'R1' }] },
  ];
  const recorder = { ok: true, time: now - 30000, message: '记下 2 条；R3.2 标为正在做', parts: [{ k: 'rec.rules', a: [2] }, { k: 'rec.doing', a: [['R3.2']] }] };
  const compile = { ok: false, time: now, message: '需求树被占用，5 秒内没拿到锁', t: { k: 'err.busy', a: [5] } };
  const b = await openPage2('en-changes.html', { lang: 'en', selId: 'R3.2', changes, recorder, compile }, 320, { tree });
  try {
    const r = await b.eval(`
      const CJK = /[\\u4e00-\\u9fff]/;
      const lines = [...document.querySelectorAll('.chg .cs')].map(e => e.textContent);
      return { lines, who: [...document.querySelectorAll('.chg .who')].map(e => e.textContent), status: document.querySelector('.status').textContent,
        banner: document.querySelector('.banner.err')?.textContent || '', cjk: [...lines, document.querySelector('.status').textContent, document.querySelector('.banner.err')?.textContent || ''].filter(t => CJK.test(t)) };`);
    assert.deepStrictEqual(r.lines, [
      'Added rule "Suspense within the first screen" to "Opening story"', 'Marked "Opening story" as In progress',
      'Renamed "Chapter Two" to "Chapter 2"', 'Deleted requirement "Old idea"',
      'Cleared 3 leftover pending marks from an old version',
      'old entry kept as stored',
    ]);
    assert.deepStrictEqual(r.who, ['Recorder', 'You', 'Upgrade', 'Recorder']);
    assert.match(r.status, /^Recorder · .* · Recorded 2 rules; marked "Opening story" in progress$/);
    assert.match(r.banner, /The requirement tree is busy; couldn't get the lock within 5 s/);
    assert.deepStrictEqual(r.cjk, [], '英文界面里还有中文');
  } finally { b.close(); }
  // 记录员出错：带 t 的按英文显示；旧的只有中文 message 的照样显示
  for (const [rec, want] of [
    [{ ok: false, time: now, message: '调用模型超时（90 秒没有返回）', t: { k: 'rec.err.timeout', a: [90] } }, /Recorder error \(.*\): The model timed out \(no reply in 90 s\)/],
    [{ ok: false, time: now, message: '旧版本的出错文字' }, /Recorder error \(.*\): 旧版本的出错文字/],
  ]) {
    const e = await openPage2('en-rec-err.html', { lang: 'en', recorder: rec }, 320, { tree });
    try { assert.match(await e.eval(`return document.querySelector('.banner.err').textContent`), want); } finally { e.close(); }
  }
  // 中文界面：同样的新记录用中文写出来，名字用需求标题
  const z = await openPage2('zh-changes.html', { selId: 'C2.2', changes: [{ ...changes[0], ops: [{ op: 'add_rule', node: 'C2.2', text: '例子要足' }] }] }, 320);
  try { assert.deepStrictEqual(await z.eval(`return [...document.querySelectorAll('.chg .cs')].map(e => e.textContent)`), ['给「英文版」加规则「例子要足」']); } finally { z.close(); }
});

// ---------- 详情的状态：只显示当前状态，点开菜单再改 ----------
// 真的按键（CDP），浏览器才会像用户按键一样触发按钮的点击、方向键处理
async function press(b, key) {
  const K = { Enter: ['Enter', 13, '\r'], ' ': ['Space', 32, ' '], Escape: ['Escape', 27], ArrowDown: ['ArrowDown', 40], ArrowUp: ['ArrowUp', 38], Home: ['Home', 36], End: ['End', 35], Tab: ['Tab', 9] }[key];
  const base = { key, code: K[0], windowsVirtualKeyCode: K[1], nativeVirtualKeyCode: K[1] };
  await b.send('Input.dispatchKeyEvent', { type: K[2] ? 'keyDown' : 'rawKeyDown', ...base, ...(K[2] ? { text: K[2] } : {}) });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(60);
}
// 页面内：状态按钮和菜单的现状
const ST_STATE = `
  const btn = document.querySelector('.dp .st-btn'), menu = document.querySelector('.menu');
  const fe = document.activeElement;
  return { btns: document.querySelectorAll('.dp .st-btn').length, segs: document.querySelectorAll('.seg, .dp [aria-pressed]').length,
    label: btn.querySelector('.st-l').textContent, aria: btn.getAttribute('aria-label'), pop: btn.getAttribute('aria-haspopup'), exp: btn.getAttribute('aria-expanded'),
    menu: menu ? { role: menu.getAttribute('role'), label: menu.getAttribute('aria-label'), items: [...menu.querySelectorAll('button')].map(x => [x.getAttribute('role'), x.dataset.s, x.getAttribute('aria-checked'), [...x.childNodes].filter(c => !(c.classList && (c.classList.contains('st') || c.classList.contains('tick')))).map(c => c.textContent).join('').trim()]) } : null,
    focus: fe === btn ? 'btn' : fe && fe.closest && fe.closest('.menu') ? 'menu:' + fe.dataset.s : fe && fe.tagName,
    posted: window.__posted.filter(m => m.type === 'edit'), errors: window.__errors };`;

test('详情状态：只显示当前状态（一个文字按钮），没有四格分段；有 aria-haspopup / aria-expanded，名字里带当前状态；中英文', { skip, timeout: 120000 }, async () => {
  const en = fs.readFileSync(path.join(__dirname, '..', 'example', 'en', 'course.tree.md'), 'utf8');
  const cases = [['zh', 'C2.2', '待做', '状态：待做', TREE], ['zh', 'C2.1', '正在做', '状态：正在做', TREE], ['zh', 'C2.3', '没有状态', '状态：没有状态', TREE],
    ['en', 'R3.2', 'In progress', 'Status: In progress', en], ['en', 'R3.3', 'Undecided', 'Status: Undecided', en]];
  for (const [lang, selId, want, aria, tree] of cases) {
    const b = await openPage2(`st-only-${lang}-${selId}.html`, { lang, selId, theme: 'dark' }, 320, { tree });
    try {
      const r = await b.eval(ST_STATE);
      assert.deepStrictEqual(r.errors, []);
      assert.strictEqual(r.btns, 1, `${selId}：状态按钮应该只有一个`);
      assert.strictEqual(r.segs, 0, `${selId}：还有分段按钮`);
      assert.strictEqual(r.label, want);
      assert.strictEqual(r.aria, aria);
      assert.strictEqual(r.pop, 'menu');
      assert.strictEqual(r.exp, 'false');
      assert.strictEqual(r.menu, null, '菜单默认关着');
      // 其他状态的名字不出现在标题区
      const head = await b.eval(`return document.querySelector('.dp .sh').textContent`);
      const all = lang === 'zh' ? ['待做', '正在做', '完成', '待定'] : ['To do', 'In progress', 'Done', 'Undecided'];
      for (const l of all.filter(l => l !== want)) assert.ok(!head.includes(l), `${selId}：标题区还显示了「${l}」`);
    } finally { b.close(); }
  }
});

test('详情状态：点开菜单列出四种状态（当前的 aria-checked），选别的发 setStatus，选当前的不发，清除发空；再点按钮、点外面都能关', { skip, timeout: 120000 }, async () => {
  for (const mode of ['side', 'map']) {
    const width = mode === 'map' ? 1300 : 320;
    const b = await openPage2(`st-menu-${mode}.html`, { selId: 'C2.2', mode, theme: mode === 'map' ? 'light' : 'dark', width, height: 800 }, width);
    try {
      const open = await b.eval(`document.querySelector('.dp .st-btn').click();` + ST_STATE);
      assert.deepStrictEqual(open.errors, []);
      assert.strictEqual(open.exp, 'true', `${mode}：打开后 aria-expanded 应为 true`);
      assert.strictEqual(open.menu.role, 'menu');
      assert.strictEqual(open.menu.label, '状态');
      assert.deepStrictEqual(open.menu.items, [
        ['menuitemradio', 'doing', 'false', '正在做'], ['menuitemradio', 'todo', 'true', '待做'], ['menuitemradio', 'done', 'false', '完成'], ['menuitemradio', 'question', 'false', '待定'],
        ['menuitem', '', null, '清除状态']]);
      assert.strictEqual(open.focus, 'menu:todo', `${mode}：打开后焦点停在当前状态上`);
      // 菜单在窗口里，贴着按钮下方
      const pos = await b.eval(`const m = document.querySelector('.menu').getBoundingClientRect(), a = document.querySelector('.dp .st-btn').getBoundingClientRect();
        return { inView: m.left >= 0 && m.right <= innerWidth && m.bottom <= innerHeight, below: m.top >= a.bottom - 1 && m.top - a.bottom < 8 };`);
      assert.ok(pos.inView && pos.below, `${mode}：菜单位置 ${JSON.stringify(pos)}`);
      // 再点一次按钮：关
      const toggled = await b.eval(`document.querySelector('.dp .st-btn').click();` + ST_STATE);
      assert.strictEqual(toggled.menu, null, `${mode}：再点按钮应该关菜单`);
      assert.strictEqual(toggled.exp, 'false');
      // 点外面：关
      const outside = await b.eval(`document.querySelector('.dp .st-btn').click(); const was = !!document.querySelector('.menu');
        document.querySelector('.dp .crumbs').click();
        return { was, now: !!document.querySelector('.menu'), exp: document.querySelector('.dp .st-btn').getAttribute('aria-expanded') };`);
      assert.deepStrictEqual(outside, { was: true, now: false, exp: 'false' }, `${mode}：点外面应该关菜单`);
      // 选当前的：不发；选「完成」：发和原来分段按钮一样的消息；清除：发空状态
      const sent = await b.eval(`
        const pick = s => { document.querySelector('.dp .st-btn').click(); [...document.querySelectorAll('.menu button')].find(x => x.dataset.s === s).click(); };
        pick('todo'); const afterSame = window.__posted.filter(m => m.type === 'edit').length;
        pick('done'); pick('');
        return { afterSame, edits: JSON.parse(JSON.stringify(window.__posted.filter(m => m.type === 'edit'))), menu: !!document.querySelector('.menu'), focusBtn: document.activeElement === document.querySelector('.dp .st-btn') };`);
      assert.strictEqual(sent.afterSame, 0, `${mode}：选当前状态不该发消息`);
      assert.deepStrictEqual(sent.edits, [
        { type: 'edit', uri: 'file:///tree.md', action: 'setStatus', node: 'C2.2', status: 'done' },
        { type: 'edit', uri: 'file:///tree.md', action: 'setStatus', node: 'C2.2', status: '' }]);
      assert.strictEqual(sent.menu, false, `${mode}：选完菜单要关`);
      assert.ok(sent.focusBtn, `${mode}：选完焦点回到状态按钮`);
    } finally { b.close(); }
  }
  // 没有状态的需求：菜单里没有「清除状态」，也没有勾选项
  const n = await openPage2('st-menu-none.html', { selId: 'C2.3' }, 320);
  try {
    const r = await n.eval(`document.querySelector('.dp .st-btn').click();` + ST_STATE);
    assert.deepStrictEqual(r.menu.items.map(x => x[1]), ['doing', 'todo', 'done', 'question']);
    assert.ok(r.menu.items.every(x => x[2] === 'false'));
  } finally { n.close(); }
});

test('详情状态：键盘能用——回车 / 空格 / 下方向键打开，方向键在菜单里移动并绕回，Esc 关上并把焦点还给按钮，回车选中', { skip, timeout: 90000 }, async () => {
  const b = await openPage2('st-keys.html', { selId: 'C2.2' }, 320);
  try {
    const st = () => b.eval(ST_STATE);
    await b.eval(`document.querySelector('.dp .st-btn').focus()`);
    await press(b, 'Enter');
    let r = await st();
    assert.ok(r.menu, '回车应该打开菜单');
    assert.strictEqual(r.exp, 'true');
    assert.strictEqual(r.focus, 'menu:todo');
    await press(b, 'ArrowDown'); assert.strictEqual((await st()).focus, 'menu:done');
    await press(b, 'ArrowDown'); await press(b, 'ArrowDown'); assert.strictEqual((await st()).focus, 'menu:', '下到「清除状态」');
    await press(b, 'ArrowDown'); assert.strictEqual((await st()).focus, 'menu:doing', '到底了绕回第一项');
    await press(b, 'ArrowUp'); assert.strictEqual((await st()).focus, 'menu:', '往上绕到最后一项');
    await press(b, 'Home'); assert.strictEqual((await st()).focus, 'menu:doing');
    await press(b, 'End'); assert.strictEqual((await st()).focus, 'menu:');
    await press(b, 'Escape');
    r = await st();
    assert.strictEqual(r.menu, null, 'Esc 应该关菜单');
    assert.strictEqual(r.exp, 'false');
    assert.strictEqual(r.focus, 'btn', 'Esc 后焦点回到按钮');
    assert.strictEqual(r.posted.length, 0, 'Esc 不该改状态');
    await press(b, ' ');
    assert.ok((await st()).menu, '空格也能打开');
    await press(b, 'Escape');
    await press(b, 'ArrowDown');
    assert.ok((await st()).menu, '下方向键也能打开');
    await press(b, 'ArrowUp'); // 待做 → 正在做
    await press(b, 'Enter');
    r = await st();
    assert.strictEqual(r.menu, null);
    assert.deepStrictEqual(r.posted.map(m => [m.action, m.node, m.status]), [['setStatus', 'C2.2', 'doing']]);
    assert.strictEqual(r.focus, 'btn');
    assert.deepStrictEqual(r.errors, []);
  } finally { b.close(); }
});

test('详情状态：英文菜单全是英文；深浅色、高对比度、侧栏和导图下文字对比度 ≥ 4.5，有焦点环，平时没有底色，比标题小，不溢出', { skip, timeout: 150000 }, async () => {
  const en = fs.readFileSync(path.join(__dirname, '..', 'example', 'en', 'course.tree.md'), 'utf8');
  const e = await openPage2('st-en.html', { lang: 'en', selId: 'R3.2' }, 300, { tree: en });
  try {
    const r = await e.eval(`document.querySelector('.dp .st-btn').click();` + ST_STATE);
    assert.strictEqual(r.menu.label, 'Status');
    assert.deepStrictEqual(r.menu.items.map(x => x[3]), ['In progress', 'To do', 'Done', 'Undecided', 'Clear status']);
    assert.deepStrictEqual(r.menu.items.map(x => x[2]), ['true', 'false', 'false', 'false', null]);
  } finally { e.close(); }
  for (const [theme, mode, width] of [['dark', 'side', 260], ['light', 'side', 340], ['hc', 'side', 320], ['light', 'map', 1300], ['dark', 'map', 1300]]) {
    const b = await openPage2(`st-look-${theme}-${mode}.html`, { theme, mode, selId: 'C2.1', width, height: 800 }, width);
    try {
      await press(b, 'Tab'); // 键盘操作过，:focus-visible 才会生效
      const r = await b.eval(`${CONTRAST}
        const btn = document.querySelector('.dp .st-btn'), title = document.querySelector('.dp .sh-title strong');
        const out = { label: contrast(btn.querySelector('.st-l')), h: btn.getBoundingClientRect().height, fs: parseFloat(getComputedStyle(btn).fontSize), titleFs: parseFloat(getComputedStyle(title).fontSize),
          bg: getComputedStyle(btn).backgroundColor, overflow: document.documentElement.scrollWidth - innerWidth, right: btn.getBoundingClientRect().right <= innerWidth };
        btn.focus(); const cs = getComputedStyle(btn); out.ring = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 1;
        btn.click(); out.menuC = Math.min(...[...document.querySelectorAll('.menu button')].map(contrast));
        return out;`);
      assert.ok(r.label >= 4.5, `${theme}/${mode}：状态文字对比度 ${r.label.toFixed(2)}`);
      assert.ok(r.menuC >= 4.5, `${theme}/${mode}：菜单文字对比度 ${r.menuC.toFixed(2)}`);
      assert.ok(r.h >= 22, `${theme}/${mode}：按钮太矮 ${r.h}`);
      assert.ok(r.fs < r.titleFs, `${theme}/${mode}：状态按钮要比标题小`);
      assert.ok(/rgba\(0, 0, 0, 0\)|transparent/.test(r.bg), `${theme}/${mode}：平时不该有底色（${r.bg}）`);
      assert.ok(r.ring, `${theme}/${mode}：没有焦点环`);
      assert.ok(r.overflow <= 0 && r.right, `${theme}/${mode}：横向溢出`);
    } finally { b.close(); }
  }
});

test('最近改动：删掉自动记忆里重复的一句（memory_remove）按界面语言写出记忆文件名和那句话', { skip, timeout: 90000 }, async () => {
  const now = Date.now();
  const changes = [
    { id: 'm1', time: now - 60000, source: '你', summary: ['删掉记忆 feedback_tone.md 里的「少用你」'], undone: false,
      ops: [{ op: 'memory_remove', dir: 'C:/x/memory', file: 'feedback_tone.md', text: '少用你', wholeFile: false, undo: [] }] },
    { id: 'm2', time: now - 120000, source: '你', summary: ['删掉记忆文件 style.md（「不引原话」）'], undone: false,
      ops: [{ op: 'memory_remove', dir: 'C:/x/memory', file: 'style.md', text: '不引原话'.repeat(20), wholeFile: true, undo: [] }] },
  ];
  const lines = b => b.eval(`return [...document.querySelectorAll('.chg .cs')].map(e => e.textContent)`);
  const z = await openPage2('mem-zh.html', { selId: 'C2.2', changes }, 320);
  try {
    const r = await lines(z);
    assert.strictEqual(r[0], '删掉记忆 feedback_tone.md 里的「少用你」');
    assert.match(r[1], /^删掉记忆文件 style\.md（「(不引原话)+不引原…」）$/);
    assert.ok(r[1].length < 90, '太长的句子要截短');
  } finally { z.close(); }
  const e = await openPage2('mem-en.html', { selId: 'C2.2', changes, lang: 'en' }, 320);
  try {
    const r = await lines(e);
    assert.strictEqual(r[0], 'Removed "少用你" from memory feedback_tone.md');
    assert.match(r[1], /^Deleted memory file style\.md \("(不引原话)+不引原…"\)$/);
    assert.ok(!r.some(l => /删掉/.test(l)), '英文界面不该用存下来的中文说明');
  } finally { e.close(); }
});

test('久未动：同一个需求已经作为问题在问（问题还开着）时，详情里不再显示久未动提示；没问、问的是别的需求、已经答过时照常显示', { skip, timeout: 120000 }, async () => {
  const q = (node, status = 'open') => ({ id: 'q-' + node, kind: 'stale', node, status, staleKey: node + '@1', text: 'x', options: [] });
  for (const [name, questions, want] of [
    ['none', [], true],
    ['asked', [q('C2.1')], false],
    ['other', [q('C2')], true],
    ['answered', [q('C2.1', 'answered')], true],
    ['notStale', [{ ...q('C2.1'), kind: 'conflict' }], true],
  ]) {
    for (const mode of ['side', 'map']) {
      const b = await openPage2(`stale-q-${name}-${mode}.html`, { selId: 'C2.1', sinceDays: 10, questions, mode, width: mode === 'map' ? 1300 : 320, height: 800 }, mode === 'map' ? 1300 : 320);
      try {
        const r = await b.eval(`return { hint: !!document.querySelector('.dp .hint'), errors: window.__errors };`);
        assert.deepStrictEqual(r.errors, []);
        assert.strictEqual(r.hint, want, `${name}/${mode}：久未动提示应该${want ? '显示' : '隐藏'}`);
      } finally { b.close(); }
    }
  }
});
