'use strict';
// 一屏需求地图的排布：纯函数，不读文件。输入是 viewData 的嵌套节点，nodes[0] 是根 P。
const MAX_TILES = 12;      // 一个块最多画几格
const RECENT_MS = 600000;  // 多久内改过算「最近」

const walk = (n, f) => { f(n); n.children.forEach(c => walk(c, f)); };
const has = (n, pred) => { let hit = false; walk(n, x => { if (pred(x)) hit = true; }); return hit; };

function overview(nodes, { working = null, now = Date.now() } = {}) {
  const totals = { done: 0, doing: 0, todo: 0, none: 0 };
  const tops = (nodes[0] && nodes[0].children) || [];
  let all = 0;
  const sizes = tops.map(b => {
    let size = 0;
    walk(b, n => { size++; totals[n.status in totals ? n.status : 'none']++; });
    all += size;
    return size;
  });

  const tileOf = n => ({
    id: n.id, title: n.title, status: n.status,
    state: has(n, x => x.id === working) ? 'working' : has(n, x => now - x.recent < RECENT_MS && x.recent > 0) ? 'recent' : null,
    hasChildren: n.children.length > 0,
  });

  const blocks = tops.map((b, i) => {
    const tiles = (b.children.length ? b.children : [b]).map(tileOf);
    const shown = tiles.slice(0, MAX_TILES);
    // 正在改的格子被挤出去时，顶掉最后一格，数量仍是 MAX_TILES
    const w = tiles.findIndex(t => t.state === 'working');
    if (w >= MAX_TILES) shown[MAX_TILES - 1] = tiles[w];
    const share = sizes[i] / all;
    return {
      id: b.id, title: b.title, status: b.status,
      span: share < 0.15 ? 1 : share < 0.35 ? 2 : 3,
      tiles: shown, hidden: tiles.length - shown.length,
    };
  });
  return { totals, blocks };
}

module.exports = { overview, MAX_TILES, RECENT_MS };
