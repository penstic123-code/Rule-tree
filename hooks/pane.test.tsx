import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'ruletree',
  component: 'Pane',
  requestId: 'ruletree-map',
  props: { title: '需求树', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const SNAPSHOT = JSON.stringify({
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
  working: null,
  overview: '',
})

const engine = (on: any) => {
  on('command.register', () => ({ value: { command: 'ruletree' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:/p' }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: SNAPSHOT, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
}

test('the pane draws requirement titles on desktop', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: 'C:/p', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /规则记录/ })).toBeTruthy()
  await ui.unmount()
})
