'use strict';
// 一屏需求地图的排布：纯函数，不读文件。输入是 viewData 的嵌套节点，nodes[0] 是根 P。
const MAX_TILES = 12;      // 一个块最多画几格
// 整张图最多画几格：一屏放得下的量。MAX_TILES 只管单个块，块一多总数仍会爆
const TILE_BUDGET = 48;
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

  // 先按块内上限挑，再按总预算收：在改和最近改过的格一定留，其余按「各块轮流取下一格」分剩下的名额，
  // 这样靠后的块不会被前面的块挤空
  const cands = tops.map(b => {
    const tiles = (b.children.length ? b.children : [b]).map(tileOf);
    // 块内上限：在改和最近改过的格先占名额（哪怕排在后面），其余按顺序补满 MAX_TILES，最后恢复原顺序
    const pick = new Set(tiles.map((t, j) => (t.state ? j : -1)).filter(j => j >= 0));
    for (let j = 0; j < tiles.length && pick.size < MAX_TILES; j++) pick.add(j);
    const shown = tiles.filter((t, j) => pick.has(j));
    return { total: tiles.length, shown };
  });
  let room = TILE_BUDGET - cands.reduce((s, c) => s + c.shown.filter(t => t.state).length, 0);
  const keep = cands.map(c => c.shown.map(t => !!t.state));
  for (let rank = 0; room > 0; rank++) {
    let any = false;
    cands.forEach((c, i) => {
      // 找这个块里第 rank 个没被留下的普通格
      const idx = c.shown.map((t, j) => j).filter(j => !keep[i][j])[0];
      if (idx !== undefined && room > 0) { keep[i][idx] = true; room--; any = true; }
    });
    if (!any) break;
  }

  const blocks = tops.map((b, i) => {
    const tiles = cands[i].shown.filter((t, j) => keep[i][j]);
    const share = sizes[i] / all;
    return {
      id: b.id, title: b.title, status: b.status,
      span: share < 0.15 ? 1 : share < 0.35 ? 2 : 3,
      tiles, hidden: cands[i].total - tiles.length,
    };
  });
  return { totals, blocks };
}

module.exports = { overview, MAX_TILES, TILE_BUDGET, RECENT_MS };
