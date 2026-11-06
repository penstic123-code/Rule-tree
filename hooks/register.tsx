import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Snapshot } from '../types'
import { paneTree, locate, describeRunError } from './pane'

const PANE = 'ruletree-map'
const ACTIVE_FOR_MS = 180000

// Atoms live here: the validator reads their plugin and key from this file.
const snapshot = atom({ plugin: 'ruletree', key: 'snapshot' } as const, null as Snapshot | null, { shape: 'snapshot-1' })
const selected = atom({ plugin: 'ruletree', key: 'selected' } as const, '', { shape: 'selected-1' })
// 当前显示哪个需求的下一层；空字符串是总览
const level = atom({ plugin: 'ruletree', key: 'level' } as const, '', { shape: 'level-1' })
// 最近一次 AI 改的文件和时间：定时刷新没有文件参数，靠它让「在改」的高亮不掉
const lastEdit = atom({ plugin: 'ruletree', key: 'lastEdit' } as const, { file: '', at: 0 }, { shape: 'lastEdit-1' })
// 刷新序号：刷新可能乱序完成，旧的不能盖掉新的
const seq = atom({ plugin: 'ruletree', key: 'seq' } as const, 0, { shape: 'seq-1' })
// 编辑或撤销没完全成功时的话；决定规则等第二次按下；正在改哪条规则
// notice / editing 带上需求编号：结果回来时用户可能已换了一格，只在它所属的需求下显示、只清它自己的
const notice = atom({ plugin: 'ruletree', key: 'notice' } as const, { node: '', text: '' }, { shape: 'notice-2' })
const armed = atom({ plugin: 'ruletree', key: 'armed' } as const, '', { shape: 'armed-1' })
const editing = atom({ plugin: 'ruletree', key: 'editing' } as const, { node: '', text: '' }, { shape: 'editing-2' })
// 正在跑的编辑个数：非 0 时再按一次直接忽略，免得连按两次发两遍、第二遍报假失败
const inflight = atom({ plugin: 'ruletree', key: 'inflight' } as const, 0, { shape: 'inflight-1' })
// 加规则成功的次数：Input 没有清空的办法，换 key 让它重新挂载
const addSeq = atom({ plugin: 'ruletree', key: 'addSeq' } as const, 0, { shape: 'addSeq-1' })
const error = atom({ plugin: 'ruletree', key: 'error' } as const, '', { shape: 'error-1' })

// Top level on purpose: the validator rejects passing `$` to a local function.
// 刷新失败时不动 snapshot：地图留着上一次好的，只把原因写进 error。
export async function refresh($: any, file?: string) {
  const mine = await update($, seq, n => n + 1)
  // 没指定文件时，沿用最近改的文件，直到过了核心的「活跃」窗口（同 viewmodel.js 的 ACTIVE_FOR_MS）
  if (!file) {
    const last = await read($, lastEdit)
    if (last.file && (await $.clock.now()) - last.at < ACTIVE_FOR_MS) file = last.file
  }
  let r: any
  try {
    const cwd = await $.session.cwd()
    const argv = ['node', `${$.plugin.root}/bin/ruletree.js`, 'snapshot', cwd, '--json']
    // 核心里 --file 用 path.resolve(cwd, file)，绝对路径原样可用，所以直接传工具给的路径
    if (file) argv.push('--file', file)
    r = await $.process.run(argv)
  } catch (err) {
    // process.run 自己被拒：没装 node 或超时，describeRunError 分开说
    await update($, error, () => describeRunError(err, '读需求树'))
    return
  }
  try {
    if (r.exitCode !== 0) throw new Error(String(r.stderr).slice(0, 300) || `snapshot exited ${r.exitCode}`)
    const data = JSON.parse(r.stdout)
    if ((await read($, seq)) !== mine) return // 已有更新的刷新开始了，这份结果作废
    await update($, snapshot, () => data)
    await update($, error, () => '')
    // 所在层的需求已不在树里：面板已退回总览，把记着的层也清掉
    const lv = await read($, level)
    if (lv && !locate(data.nodes, lv)) await update($, level, () => '')
  } catch (err) {
    await update($, error, () => `刷新失败，下面是上一次的地图：${String(err).slice(0, 300)}`)
  }
}

// 改规则或撤销：同样放在顶层，因为校验器不让把 `$` 交给本地函数。
// JSON 走标准输入（$.process.run 的 stdin），不放进命令行，免得引号和中文出问题。
// node 是这次编辑所属的需求：结果回来时用户可能已选了别的格，话只挂在它名下。
// 不管结果如何都刷新；不是 done 就把 message 给用户看，并保留正在改的输入，别丢用户打的字。
export async function runEdit($: any, input: { ops: any[] } | { undo: string }, node: string) {
  // update 返回新值：大于 1 说明已有一次在跑，这次忽略
  if ((await update($, inflight, n => n + 1)) > 1) {
    await update($, inflight, n => n - 1)
    return
  }
  try {
    let message = ''
    let isDone = false
    try {
      const cwd = await $.session.cwd()
      const r = await $.process.run(['node', `${$.plugin.root}/bin/ruletree.js`, 'edit', cwd, '--json'], { stdin: JSON.stringify(input) })
      let out: any = null
      try { out = JSON.parse(r.stdout) } catch {}
      isDone = !!(out && out.result === 'done')
      if (!isDone) message = (out && out.message) || String(r.stderr).slice(0, 200) || `edit exited ${r.exitCode}`
    } catch (err) {
      message = describeRunError(err, '改需求树')
    }
    await update($, notice, () => ({ node, text: message }))
    await update($, armed, () => '')
    if (isDone) {
      await update($, editing, e => (e.node === node ? { node: '', text: '' } : e))
      if ('ops' in input && input.ops.some(o => o.op === 'add_rule')) await update($, addSeq, n => n + 1)
    }
  } finally {
    await update($, inflight, n => n - 1)
  }
  await refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ruletree', description: 'Open the requirement map' })
    await refresh($)
    // Open unasked only where a pane docks beside the chat; the terminal stays quiet.
    if (e.surface && e.surface !== 'terminal') $.ui.open({ id: PANE, title: '需求树' }).catch(() => {})
    // 慢速定时刷新：捕到会话外和子 agent 的改动
    $.clock.every(30000, () => {
      refresh($).catch(() => {})
    })
    return next(e)
  })

  on('command.run', { command: 'ruletree' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: '需求树' })
    return { text: 'Requirement map opened.' }
  })

  // AI 改文件：先让它改，再在后台刷新，AI 一点不被拖慢
  for (const tool of ['Edit', 'Write'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const ran = await next(e)
      const now = await $.clock.now()
      const file = String((e as any).file_path ?? '')
      if (file) await update($, lastEdit, () => ({ file, at: now }))
      refresh($, file || undefined).catch(() => {})
      return ran
    }).catch(($, e, next) => next(e)) // 刷新出错不能挡住 AI 的改动
  }

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e) as any
    // 渲染只读状态；写状态都在下面的按下回调里
    const state = {
      snap: await read($, snapshot),
      err: await read($, error),
      selected: await read($, selected),
      level: await read($, level),
      armed: await read($, armed),
      editing: await read($, editing),
      notice: await read($, notice),
      addSeq: await read($, addSeq),
      surface: String((e as any).surface),
    }
    return paneTree(els, state, {
      onTile: async tile => {
        await update($, selected, () => tile.id)
        await update($, notice, () => ({ node: '', text: '' }))
        await update($, armed, () => '')
        await update($, editing, () => ({ node: '', text: '' }))
        if (tile.hasChildren) await update($, level, () => tile.id)
      },
      onBack: async to => {
        await update($, level, () => to)
      },
      onEdit: async (node, ops) => { await runEdit($, { ops }, node) },
      onUndo: async (node, id) => { await runEdit($, { undo: id }, node) },
      onArm: async text => { await update($, armed, () => text) },
      onEditing: async (node, text) => {
        await update($, editing, () => ({ node: text ? node : '', text }))
        await update($, armed, () => '')
      },
    })
  })
}
