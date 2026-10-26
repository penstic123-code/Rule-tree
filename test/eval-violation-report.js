'use strict';
// 汇总 eval-violation-run.js 的结果：node test/eval-violation-report.js <工作目录>
const fs = require('fs');
const path = require('path');
const dir = path.join(path.resolve(process.argv[2]), 'results');
const REJUDGE = process.argv.includes('--rejudge'); // 判定脚本改过后，对保存的项目副本重新判定
const { judge } = require('./eval-violation');
const R = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
  .map(r => { if (!REJUDGE) return r; Object.assign(r, judge(path.join(dir, '..', 'runs', r.name), r.task, process.env.EVAL_V2 === '1')); fs.writeFileSync(path.join(dir, r.name + '.json'), JSON.stringify(r, null, 1)); return r; });
const by = (f) => { const m = {}; for (const r of R) (m[f(r)] = m[f(r)] || []).push(r); return m; };
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const MAIN = /^T\d+$/;
const main = R.filter(r => MAIN.test(r.task));

console.log('## 按条件汇总（主实验 T1–T8）');
console.log('条件 | 次数 | 违反总数 | 有违反的次数 | 完成 | 平均花费 | 平均回合 | 平均输入token | 平均耗时秒');
for (const [c, a] of Object.entries(by(r => r.cond)).sort()) {
  const m = a.filter(r => MAIN.test(r.task)); if (!m.length) continue;
  console.log([c, m.length, sum(m, r => r.violations.length), m.filter(r => r.violations.length).length, m.filter(r => r.done).length,
    '$' + (sum(m, r => r.cost) / m.length).toFixed(3), (sum(m, r => r.turns) / m.length).toFixed(1), Math.round(sum(m, r => r.input) / m.length), (sum(m, r => r.wallMs) / m.length / 1000).toFixed(0)].join(' | '));
}
console.log('\n## 逐任务：违反数（3 遍合计）/ 完成数 / 平均花费');
const tasks = [...new Set(main.map(r => r.task))].sort();
console.log('任务 | A | B | C');
for (const t of tasks) {
  console.log(t + ' | ' + ['A', 'B', 'C'].map(c => { const a = main.filter(r => r.task === t && r.cond === c); return a.length ? `${sum(a, r => r.violations.length)}违/${a.filter(r => r.done).length}完/${a.length}次/$${(sum(a, r => r.cost) / a.length).toFixed(2)}` : '-'; }).join(' | '));
}
console.log('\n## 逐规则：违反次数（A/B/C）');
const ids = [...new Set(main.flatMap(r => r.violations.map(v => v.rule)))].sort();
for (const id of ids) console.log(id + ' | ' + ['A', 'B', 'C'].map(c => main.filter(r => r.cond === c).reduce((n, r) => n + r.violations.filter(v => v.rule === id).length, 0)).join(' | '));
console.log('\n## 每一次');
for (const r of R.sort((a, b) => a.name.localeCompare(b.name))) console.log(`${r.name} | 违反 ${r.violations.map(v => v.rule + '@' + v.file).join(',') || '-'} | 完成 ${r.done} | $${r.cost.toFixed(3)} | ${r.turns}回合 | 读规则文件 ${r.reads.filter(x => /rules\/ruletree/.test(x)).length} | ${r.isError ? '出错 ' + r.subtype : ''}`);
console.log('\n## A 条件加载的规则字数（context.jsonl）');
for (const r of R.filter(x => x.cond === 'A' && x.ctx)) console.log(`${r.name} | ${r.ctx.length}次加载 | ${sum(r.ctx, c => c.chars || 0)}字 | ${r.ctx.map(c => c.file.split('/').pop().replace('.md', '') + (c.reason === 'session_start' ? '' : '*')).join(' ')}`);

// 诱导违反的任务：AI 的反应分类。照做 = 违反了；照做并说明 = 违反了且回复里提到规则冲突；问 = 没改文件；改做法 = 改了文件但没违反（按规则做，换了办法）
console.log('\n## 诱导任务的反应（照做 / 照做并说明 / 问 / 改做法）');
const kind = r => {
  const said = /规则|冲突|违反|不符合|例外/.test(r.text);
  if (!r.changed.length) return '问';
  if (r.violations.length) return said ? '照做并说明' : '照做不说明';
  return '改做法';
};
for (const t of ['T3', 'T4', 'T6', 'T7', 'Ec']) {
  const row = c => { const a = R.filter(r => r.task === t && r.cond === c); if (!a.length) return '-'; const m = {}; a.forEach(r => { m[kind(r)] = (m[kind(r)] || 0) + 1; }); return Object.entries(m).map(([k, v]) => `${k}${v}`).join(' '); };
  console.log(`${t} | A: ${row('A')} | B: ${row('B')} | C: ${row('C')}`);
}
