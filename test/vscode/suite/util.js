'use strict';
const fs = require('fs');
const path = require('path');

const WS = process.env.RT_WS;
const TREE = path.join(WS, '需求树.md');
const RULES = path.join(WS, '.claude', 'rules', 'reqtree');
const EXT_ID = 'shidipeng.reqtree';

const sleep = ms => new Promise(r => setTimeout(r, ms));
// 轮询直到 fn() 为真（fn 抛错算假），超时报 label
async function waitFor(fn, label, ms = 10000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(100);
  }
  throw new Error(`等不到：${label}${last ? `（最后一次出错：${last.message}）` : ''}`);
}
const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const lastChange = () => {
  const lines = (read(path.join(WS, '.reqtree', 'changes.jsonl')) || '').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  return lines.filter(e => e.id).pop();
};

module.exports = { WS, TREE, RULES, EXT_ID, sleep, waitFor, read, samePath, lastChange };
