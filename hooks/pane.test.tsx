import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'ruletree',
  component: 'Pane',
  requestId: 'ruletree-map',
  props: { title: '需求树', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const tile = (id: string, title: string, status: string | null, state: string | null = null) => ({
  id, title, status, state, hasChildren: false,
})
const snap = (working: string | null) => ({
  enabled: true,
  dir: 'C:/p/.claude/rules/ruletree',
  name: 'P',
  nodes: [
    {
      id: 'P',
      title: '需求树',
      status: null,
      children: [{ id: 'R1', title: '规则记录', status: 'doing', children: [] }],
    },
  ],
  changes: [],
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
let run: (e?: any) => any = () => ({ value: ok(SNAPSHOT) })
const engine = (on: any, answer: (e?: any) => any = () => ({ value: ok(SNAPSHOT) })) => {
  run = answer
  on('command.register', () => ({ value: { command: 'ruletree' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
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
