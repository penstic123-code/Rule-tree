'use strict';
// overview：一屏需求地图的排布（纯函数）
const test = require('node:test');
const assert = require('node:assert');
const { overview, MAX_TILES, RECENT_MS } = require('../src/layout');

const n = (id, status, children = [], recent = 0) => ({ id, title: id, status, recent, children });
const root = (...blocks) => [n('P', null, blocks)];
const tile = (o, id) => o.blocks.flatMap(b => b.tiles).find(t => t.id === id);

// b 个块，每块 k 个直接下级
const makeTree = (b, k) => root(...Array.from({ length: b }, (_, i) =>
  n(`R${i + 1}`, 'todo', Array.from({ length: k }, (_, j) => n(`R${i + 1}.${j + 1}`, 'todo')))));
const flatTree = c => root(...Array.from({ length: c }, (_, i) => n(`R${i + 1}`, 'todo')));
const tree = root(
  n('R1', 'doing', [n('R1.1', 'done'), n('R1.2', 'doing', [n('R1.2.3', 'todo')])]));

test('fits a 200-requirement tree', () => {
  const o = overview(makeTree(8, 24), {});
  assert.ok(o.blocks.every(b => b.tiles.length <= MAX_TILES));
  assert.strictEqual(o.blocks.reduce((s, b) => s + b.tiles.length + b.hidden, 0), 192);
});
test('a working requirement deep in the tree lights its visible ancestor tile', () => {
  assert.strictEqual(tile(overview(tree, { working: 'R1.2.3' }), 'R1.2').state, 'working');
});
test('a working tile past the cap is kept visible', () => {
  const o = overview(makeTree(1, 30), { working: 'R1.30' });
  assert.strictEqual(tile(o, 'R1.30').state, 'working');
  assert.strictEqual(o.blocks[0].tiles.length, MAX_TILES);
  assert.strictEqual(o.blocks[0].hidden, 30 - MAX_TILES);
});
test('a flat project still gets a useful map', () => {
  assert.strictEqual(overview(flatTree(3), {}).blocks[0].tiles.length, 1);
});
test('counts statuses without the root', () => {
  assert.deepStrictEqual(overview(tree, {}).totals, { done: 1, doing: 2, todo: 1, none: 0 });
});
test('span follows the block share', () => {
  const o = overview(makeTree(2, 1), {}); // 各占 50%
  assert.deepStrictEqual(o.blocks.map(b => b.span), [3, 3]);
  const big = overview(makeTree(8, 1), {}); // 各占 12.5%
  assert.ok(big.blocks.every(b => b.span === 1));
  assert.strictEqual(overview(makeTree(4, 1), {}).blocks[0].span, 2); // 25%
});
test('recent tiles are marked within RECENT_MS, including descendants', () => {
  const now = 10 * RECENT_MS;
  const t = root(n('R1', 'todo', [n('R1.1', 'todo', [n('R1.1.1', 'todo', [], now - 1000)], now - 1000), n('R1.2', 'todo', [], now - RECENT_MS - 1)], now - 1000));
  const o = overview(t, { now });
  assert.strictEqual(tile(o, 'R1.1').state, 'recent');
  assert.strictEqual(tile(o, 'R1.2').state, null);
});
test('a working tile wins over recent', () => {
  const now = 10 * RECENT_MS;
  const t = root(n('R1', 'todo', [n('R1.1', 'todo', [], now)], now));
  assert.strictEqual(tile(overview(t, { working: 'R1.1', now }), 'R1.1').state, 'working');
});
