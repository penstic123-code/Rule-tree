import { expect, mock, test } from 'claude-code/testing'

import { cellsOf, fit, mapRows, reportBody, tileColumns } from './pane'

const PANE = {
  plugin: 'ruletree',
  component: 'Pane',
  requestId: 'ruletree-map',
  props: { title: '需求树', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const tile = (id: string, title: string, status: string | null, state: string | null = null) => ({
  id, title, status, state, hasChildren: false,
})
const snap = (working: string | null, lang: 'zh' | 'en' = 'zh') => ({
  enabled: true,
  lang,
  dir: 'C:/p/.claude/rules/ruletree',
  name: 'P',
  nodes: [
    {
      id: 'P',
      title: '需求树',
      status: null,
      files: [],
      docs: [],
      groups: [],
      children: [
        {
          id: 'R1', title: '规则记录', status: 'doing', children: [],
          files: ['src/**'],
          docs: [],
          groups: [
            {
              self: true, ownerId: 'R1', ownerTitle: '规则记录',
              rules: [
                { text: '先写测试', shown: '先写测试', state: 'own' },
                { text: '决定：别删我', shown: '决定：别删我', state: 'own' },
              ],
            },
          ],
        },
      ],
    },
  ],
  changes: [{ id: 'c1', time: 1, source: '你', summary: ['给 R1 加规则「先写测试」'], undone: false, undoable: true }],
  unmapped: [],
  problems: [],
  working,
  overview: {
    totals: { done: 0, doing: 1, todo: 0, none: 0 },
    blocks: [
      {
        id: 'R1', title: '规则记录', status: 'doing', span: 1, hidden: 0,
        tiles: [tile('R1', '规则记录', 'doing', working === 'R1' ? 'working' : null)],
      },
    ],
  },
})
const SNAPSHOT = JSON.stringify(snap(null))
const ok = (out: string) => ({ exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

// process.run 只能注册一次，所以让每个测试改这个变量来换回答
const openTitles: string[] = []
let run: (e?: any) => any = () => ({ value: ok(SNAPSHOT) })
const engine = (on: any, answer: (e?: any) => any = () => ({ value: ok(SNAPSHOT) })) => {
  run = answer
  on('command.register', () => ({ value: { command: 'ruletree' } }))
  on('ui.open', (_: any, e: any) => { openTitles.push(e.title); return { value: { isPlaced: true } } })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:/p' }))
  on('process.run', (_: any, e: any) => run(e))
  return mock.clock(on)
}

test('the pane draws requirement titles on desktop', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /规则记录/ })).toBeTruthy()
  await ui.unmount()
})

test('an edit lights the owning tile', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  run = () => ({ value: ok(JSON.stringify(snap('R1'))) })
  await $.tool.call({ tool: 'Edit', file_path: 'C:/p/src/a.js', old_string: 'a', new_string: 'b' })
  await new Promise(r => setTimeout(r, 100)) // 刷新在后台跑，等它落地

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', text: /在改/ })).toBeTruthy()
  await ui.unmount()
})

test('a timer refresh keeps the tile lit while the edit is recent', async ($, on) => {
  const clock = engine(on)
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  // 像核心那样：只有带 --file 才算得出 working
  run = e => ({ value: ok(JSON.stringify(snap(JSON.stringify(e).includes('--file') ? 'R1' : null))) })
  await $.tool.call({ tool: 'Edit', file_path: 'C:/p/src/a.js', old_string: 'a', new_string: 'b' })
  await new Promise(r => setTimeout(r, 100))
  await clock.advance(30000) // 定时刷新，没有文件参数
  await new Promise(r => setTimeout(r, 100))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', text: /在改/ })).toBeTruthy()
  await ui.unmount()
})

test('a failed refresh keeps the last good map and shows the reason', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  run = () => ({ value: { ...ok(''), exitCode: 1, stderr: 'bad file R2-x.md' } })
  await $.command.run({ command: 'ruletree' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /规则记录/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /R2-x\.md/ })).toBeTruthy()
  await ui.unmount()
})

test('missing Node says so', async ($, on) => {
  engine(on, () => ({ deny: 'spawn node ENOENT' }))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Node\.js/ })).toBeTruthy()
  await ui.unmount()
})

test('not enabled offers setup', async ($, on) => {
  engine(on, () => ({ value: ok(JSON.stringify({ ...snap(null), enabled: false, nodes: [], overview: null })) }))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /\/ruletree:setup/ })).toBeTruthy()
  await ui.unmount()
})

test('the terminal draws a text tree', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: 'C:/p', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /规则记录/ })).toBeTruthy()
  await ui.unmount()
})

test('pressing a tile shows its id and title under the map', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'b-R1' })
  expect(await ui.find({ type: 'Text', text: /已选：R1 规则记录/ })).toBeTruthy()
  await ui.unmount()
})

// process.run 的参数里带 edit 的那次，记下来看按了几次、送了什么
const editCalls = () => calls.filter(c => JSON.stringify(c).includes('"edit"'))
let calls: any[] = []
const withEdit = (answer: (e: any) => any) => (e: any) => {
  calls.push(e)
  return JSON.stringify(e).includes('"edit"') ? answer(e) : { value: ok(SNAPSHOT) }
}
const done = () => ({ value: ok(JSON.stringify({ ok: true, result: 'done' })) })

test('deleting a decision rule asks first', async ($, on) => {
  calls = []
  engine(on, withEdit(done))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'b-R1' })

  await ui.press({ key: 'd-R1-1' })
  expect(editCalls().length).toBe(0)
  expect(await ui.find({ type: 'Button', text: /再按一次/ })).toBeTruthy()

  await ui.press({ key: 'd-R1-1' })
  expect(editCalls().length).toBe(1)
  expect(JSON.stringify(editCalls()[0])).toContain('remove_rule')
  await ui.unmount()
})

test('deleting a plain rule runs at once', async ($, on) => {
  calls = []
  engine(on, withEdit(done))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'b-R1' })
  await ui.press({ key: 'd-R1-0' })
  expect(editCalls().length).toBe(1)
  await ui.unmount()
})

test('a result that is not done shows its message', async ($, on) => {
  calls = []
  engine(on, withEdit(() => ({ value: ok(JSON.stringify({ ok: true, result: 'partial', message: '只撤销了一部分' })) })))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'b-R1' })
  await ui.press({ key: 'undo-c1' })
  expect(editCalls().length).toBe(1)
  expect(await ui.find({ type: 'Text', text: /只撤销了一部分/ })).toBeTruthy()
  await ui.unmount()
})

test('the status Select sends set_status for the selected node', async ($, on) => {
  calls = []
  engine(on, withEdit(done))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'b-R1' })
  await ui.select({ key: 'status-R1', value: 'done' })
  expect(editCalls().length).toBe(1)
  const sent = JSON.stringify(editCalls()[0])
  expect(sent).toContain('set_status')
  expect(sent).toContain('done')
  await ui.unmount()
})

test('the add-rule Input sends add_rule and remounts after success', async ($, on) => {
  calls = []
  engine(on, withEdit(done))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'b-R1' })
  await ui.input({ key: 'add-R1-0', text: '新规则' })
  expect(editCalls().length).toBe(1)
  expect(JSON.stringify(editCalls()[0])).toContain('add_rule')
  // 成功后 key 换成 add-R1-1，旧的输入框已卸载
  expect(await ui.find({ type: 'Input', key: 'add-R1-1' })).toBeTruthy()
  await ui.unmount()
})

test('a second press is ignored while an edit is running', async ($, on) => {
  calls = []
  engine(on, withEdit(async () => {
    await new Promise(r => setTimeout(r, 100))
    return done()
  }))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'b-R1' })
  await Promise.all([ui.press({ key: 'd-R1-0' }), ui.press({ key: 'd-R1-0' })])
  expect(editCalls().length).toBe(1)
  await ui.unmount()
})

test('a failed edit keeps the typing open and shows the notice under its own node', async ($, on) => {
  calls = []
  engine(on, withEdit(() => ({ value: ok(JSON.stringify({ ok: true, result: 'nochange', message: '这条规则已经变了，请重新看一下再改' })) })))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'b-R1' })
  await ui.press({ key: 'e-R1-0' })
  await ui.input({ key: 'edit-R1-0', text: '改过的' })
  expect(await ui.find({ type: 'Text', text: /已经变了/ })).toBeTruthy()
  expect(await ui.find({ type: 'Input', key: 'edit-R1-0' })).toBeTruthy()
  await ui.unmount()
})

test('a timeout is not reported as missing Node', async ($, on) => {
  calls = []
  engine(on, withEdit(() => ({ deny: 'command timed out after 30000ms' })))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'b-R1' })
  await ui.press({ key: 'd-R1-0' })
  expect(await ui.find({ type: 'Text', text: /timed out/ })).toBeTruthy()
  await ui.unmount()
})

// 英文项目：固定文字用英文画；项目自己的标题和规则原样
test('the pane draws its fixed strings in English for an English project', async ($, on) => {
  engine(on, () => ({ value: ok(JSON.stringify(snap('R1', 'en'))) }))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 100))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /✓ Done 0 · ◐ In progress 1 · ○ To do 0/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /editing/ })).toBeTruthy()
  await ui.unmount()
})

test('a project without rules gets the English not-enabled message', async ($, on) => {
  engine(on, () => ({ value: ok(JSON.stringify({ enabled: false, dir: null, name: 'p', nodes: [], changes: [], unmapped: [], problems: [], working: null, overview: null, lang: 'en' })) }))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 100))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /does not use a requirement tree yet/ })).toBeTruthy()
  await ui.unmount()
})

// ---- 体检：按钮、运行中、报告、失败原因；用会话的模型，最多 3 个同时，超时重试一次 ----
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const reply = (text: string) => ({ value: { isAnswered: true, text, usage: {} } })
const REPORT = '# 需求树体检报告\n\n2026-11-06\n\n需求树体检：直接改了 1 处\n\n## 直接改了的\n\n- 删掉了一条重复的规则\n'
let answered: any[] = []
// jobs：每个 { prompt, rules }；answers 命令收到的 stdin 记在 answered 里
const checkupCli = (jobs: any[], outcome: any = { ok: true, report: REPORT, applied: 1, error: null, failed: [] }) => (e: any) => {
  const s = JSON.stringify(e)
  if (s.includes('--jobs')) return { value: ok(JSON.stringify(jobs)) }
  if (s.includes('--answers')) { answered = JSON.parse(e.init.stdin); return { value: ok(JSON.stringify(outcome)) } }
  return { value: ok(SNAPSHOT) }
}
const jobsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ prompt: `prompt ${i}`, rules: 10 }))

test('the checkup button runs the session model and shows the report', async ($, on) => {
  answered = []
  engine(on, checkupCli(jobsOf(2)))
  const asked: any[] = []
  on('model.complete', (_: any, e: any) => { asked.push(e); return reply('{"fixes":[]}') })
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'checkup' })
  expect(asked.map(a => a.model)).toEqual(['haiku', 'haiku'])
  expect(answered.map(a => a.prompt).sort()).toEqual(['prompt 0', 'prompt 1'])
  expect(await ui.find({ type: 'Text', text: /删掉了一条重复的规则/ })).toBeTruthy()
  // 报告里没有原始数字：标题、日期、带数字的总结行都不画
  expect(await ui.find({ type: 'Text', text: /直接改了 1 处/ })).toBeFalsy()
  await ui.unmount()
})

test('while the checkup runs the button says so, and a second press is ignored', async ($, on) => {
  answered = []
  engine(on, checkupCli(jobsOf(1)))
  let calls = 0
  on('model.complete', async () => { calls++; await sleep(150); return reply('{"fixes":[]}') })
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const first = ui.press({ key: 'checkup' })
  await sleep(50)
  expect(await ui.find({ type: 'Button', text: /体检中/ })).toBeTruthy()
  await ui.press({ key: 'checkup' })
  await first
  expect(calls).toBe(1)
  expect(await ui.find({ type: 'Button', text: /^体检$/ })).toBeTruthy()
  await ui.unmount()
})

test('the checkup runs at most 3 model calls at once', async ($, on) => {
  answered = []
  engine(on, checkupCli(jobsOf(7)))
  let live = 0, peak = 0, total = 0
  on('model.complete', async () => { total++; live++; peak = Math.max(peak, live); await sleep(40); live--; return reply('{"fixes":[]}') })
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'checkup' })
  expect(total).toBe(7)
  expect(peak).toBe(3)
  expect(answered.length).toBe(7)
  await ui.unmount()
})

test('a timed-out block is retried once, with more time', async ($, on) => {
  answered = []
  engine(on, checkupCli([{ prompt: 'slow', rules: 10 }, { prompt: 'dead', rules: 10 }, { prompt: 'fine', rules: 10 }]))
  const seen: Record<string, number[]> = {}
  on('model.complete', (_: any, e: any) => {
    ;(seen[e.prompt] = seen[e.prompt] || []).push(e.timeoutMs)
    if (e.prompt === 'dead' || (e.prompt === 'slow' && seen.slow.length === 1)) return { value: { isAnswered: false, reason: 'aborted', usage: {} } }
    return reply('{"fixes":[]}')
  })
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'checkup' })
  expect(seen.slow.length).toBe(2)
  expect(seen.slow[1]).toBe(Math.round(seen.slow[0] * 1.5))
  expect(seen.dead.length).toBe(2) // 再试一次就停，不无限重试
  expect(seen.fine.length).toBe(1)
  // 问不到答案的那块不送答案，核心把它记成没问成
  expect(answered.map(a => a.prompt).sort()).toEqual(['fine', 'slow'])
  await ui.unmount()
})

test('a checkup that cannot start shows its reason and keeps the map', async ($, on) => {
  engine(on, (e: any) => (JSON.stringify(e).includes('--jobs') ? { value: { ...ok(''), exitCode: 1, stderr: 'no rules here' } } : { value: ok(SNAPSHOT) }))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'checkup' })
  expect(await ui.find({ type: 'Text', text: /体检没成功.*no rules here/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /规则记录/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /^体检$/ })).toBeTruthy() // 可以再按
  await ui.unmount()
})

test('a checkup the model could not answer says why exactly once', async ($, on) => {
  // 真实的报告里已经写了原因，核心又把它放进 error：只画一遍
  const report = '# Checkup\n\n11/6/2026\n\nCheckup: changed 0\n\nThe model failed (No answer came back for this part), so only the program checks ran\n'
  engine(on, checkupCli(jobsOf(1), { ok: true, report, applied: 0, error: 'No answer came back for this part', failed: [] }))
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: {} } }))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'checkup' })
  expect(answered).toEqual([])
  expect(await ui.findAll({ type: 'Text', text: /No answer came back/ })).toHaveLength(1)
  await ui.unmount()
})

test('a checkup that timed out says so in words, with no milliseconds', async ($, on) => {
  engine(on, (e: any) => (JSON.stringify(e).includes('--jobs') ? { deny: 'command timed out after 120000ms' } : { value: ok(SNAPSHOT) }))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'checkup' })
  expect(await ui.find({ type: 'Text', text: /等太久了/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /120000/ })).toBeFalsy()
  await ui.unmount()
})

// 和 src/checkup.js 的 report() 的约定：去掉空行后的前三行是标题、日期、总结，第四行起才是正文。
// test/checkup.test.js 从核心那边钉同一件事
test('the pane drops exactly the report title, date and summary', () => {
  expect(reportBody(REPORT)).toEqual(['## 直接改了的', '- 删掉了一条重复的规则'])
  expect(reportBody('# 标题\n\n日期\n\n总结 3 处\n')).toEqual([])
})

test('a new session frees the buttons a reload left busy', async ($, on) => {
  calls = []
  let release: (v: any) => void = () => {}
  let asked = 0
  engine(on, withEdit(() => new Promise(r => { release = r })))
  const cli = checkupCli(jobsOf(1))
  const edits = run
  run = e => (JSON.stringify(e).includes('checkup') ? cli(e) : edits(e))
  on('model.complete', () => { asked++; return asked === 1 ? new Promise(() => {}) : reply('{"fixes":[]}') })
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'b-R1' })
  // 两件活都跑到一半、永远不回来，就像插件在这时重载了
  void ui.press({ key: 'checkup' })
  void ui.press({ key: 'd-R1-0' })
  await sleep(50)
  expect(editCalls().length).toBe(1)
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  expect(await ui.find({ type: 'Button', text: /^体检$/ })).toBeTruthy()
  await ui.press({ key: 'checkup' })
  expect(asked).toBe(2)
  release(done())
  await sleep(50)
  void ui.press({ key: 'd-R1-0' })
  await sleep(50)
  expect(editCalls().length).toBe(2)
  release(done())
  await ui.unmount()
})

test('an English project sees English in the checkup button and the pane title', async ($, on) => {
  engine(on, (e: any) => (JSON.stringify(e).includes('--jobs') ? { value: ok('[]') } : { value: ok(JSON.stringify(snap(null, 'en'))) }))
  openTitles.length = 0
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  await sleep(50)
  expect(openTitles).toEqual(['Requirement map'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', text: /^Checkup$/ })).toBeTruthy()
  await ui.unmount()
})

test('recent changes join with the language separator', async ($, on) => {
  const s: any = snap(null, 'en')
  s.changes = [{ id: 'c1', time: 1, source: 'You', summary: ['Added rule "a" to R1', 'Removed rule "b" from R1'], undone: false, undoable: true }]
  engine(on, () => ({ value: ok(JSON.stringify(s)) }))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  await sleep(50)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'b-R1' })
  expect(await ui.find({ type: 'Text', text: /Added rule "a" to R1; Removed rule "b" from R1/ })).toBeTruthy()
  await ui.unmount()
})

// ---- 一屏看全：8 块约 48 格，60 列 ----
const bigSnap = (lang: 'zh' | 'en' = 'zh') => {
  const s: any = snap(null, lang)
  const long = '这是一个标题特别特别特别特别特别特别长的需求用来试截断'
  const leaf = (id: string, title: string, status: string | null) => ({ id, title, status, files: [], docs: [], groups: [], children: [] })
  const blocks = Array.from({ length: 8 }, (_, b) => {
    const id = `R${b + 1}`
    const kids = Array.from({ length: 6 }, (_, k) => leaf(`${id}.${k + 1}`, k === 0 ? long : `第${k + 1}格`, k < 2 ? 'done' : k === 2 ? 'doing' : 'todo'))
    return { ...leaf(id, `第${b + 1}块`, 'doing'), children: kids }
  })
  s.nodes[0].children = blocks
  s.working = 'R3.4'
  s.overview = {
    totals: { done: 16, doing: 16, todo: 24, none: 0 },
    blocks: blocks.map(b => ({
      id: b.id, title: b.title, status: b.status, span: 1, hidden: 0,
      tiles: b.children.map(c => tile(c.id, c.title, c.status, c.id === s.working ? 'working' : null)),
    })),
  }
  return s
}

test('a big project fits one screen at 60 columns', async ($, on) => {
  const s = bigSnap()
  engine(on, () => ({ value: ok(JSON.stringify(s)) }))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  await sleep(50)
  expect(tileColumns(60)).toBe(2)
  // 8 个块标题 + 24 行格子，加上总数、在改、体检，还在 40 行以内
  expect(mapRows(s.overview.blocks, 60)).toBe(32)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Button', text: /第\d格|标题/ })).length).toBe(48)
  await ui.unmount()
})

test('the working tile stands out in words, not only colour, and the status line names it', async ($, on) => {
  engine(on, () => ({ value: ok(JSON.stringify(bigSnap())) }))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  await sleep(50)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /● AI 在改：R3\.4 第4格/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /○ R3\.4 第4格 ● 在改/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /✓ R1\.2 第2格/ })).toBeTruthy() // 状态有记号，不只靠颜色
  expect(await ui.find({ type: 'Text', text: /◐ R1\.3 第3格/ })).toBeTruthy()
  await ui.unmount()
})

test('each block shows how many of its parts are done', async ($, on) => {
  engine(on, () => ({ value: ok(JSON.stringify(bigSnap())) }))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  await sleep(50)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.findAll({ type: 'Text', text: /^2\/6$/ })).toHaveLength(8)
  await ui.unmount()
})

test('long titles stop at the tile edge, counting wide characters as two cells', async ($, on) => {
  expect(cellsOf('体检 ab')).toBe(7)
  expect(fit('体检与整理', 7)).toBe('体检与…')
  expect(cellsOf(fit('体检与整理', 6))).toBe(5) // 半个字放不下时宁可留空，不撑破
  expect(fit('short', 7)).toBe('short')
  engine(on, () => ({ value: ok(JSON.stringify(bigSnap())) }))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  await sleep(50)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const cut = await ui.find({ type: 'Text', text: /R1\.1 这是/ })
  expect(cut?.text.endsWith('…')).toBe(true)
  expect(cellsOf(String(cut?.text))).toBeLessThanOrEqual(29)
  await ui.unmount()
})

test('a block without children draws one tile, not its title twice', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.findAll({ type: 'Text', text: /规则记录/ })).toHaveLength(1)
  await ui.unmount()
})

test('not enabled gives the setup command a line of its own', async ($, on) => {
  engine(on, () => ({ value: ok(JSON.stringify({ ...snap(null), enabled: false, nodes: [], overview: null })) }))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  await sleep(50)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /ruletree:setup/ }))?.text).toBe('/ruletree:setup')
  await ui.unmount()
})

test('an empty tree says what to do next', async ($, on) => {
  const s: any = snap(null)
  s.nodes[0].children = []
  s.overview = { totals: { done: 0, doing: 0, todo: 0, none: 1 }, blocks: [] }
  engine(on, () => ({ value: ok(JSON.stringify(s)) }))
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })
  await sleep(50)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /第一批需求/ })).toBeTruthy()
  await ui.unmount()
})

test('before the first snapshot the pane says it is reading', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Reading the project/ })).toBeTruthy()
  await ui.unmount()
})

test('the terminal stays a plain text tree', async ($, on) => {
  engine(on, () => ({ value: ok(JSON.stringify(bigSnap())) }))
  await $.session.start({ cwd: 'C:/p', surface: 'terminal', isInteractive: true })
  await sleep(50)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /R3\.4 第4格 \[待做\] ● 在改/ })).toBeTruthy()
  await ui.unmount()
})
