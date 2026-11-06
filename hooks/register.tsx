import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Snapshot } from '../types'
import { paneTree, locate, describeRunError, describeCheckupError, strings } from './pane'

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
// 体检：阶段、报告、没跑成的原因。running 期间再按一次直接忽略（checkupBusy 计数）
const checkup = atom({ plugin: 'ruletree', key: 'checkup' } as const, { phase: 'idle', text: '', reason: '' }, { shape: 'checkup-1' })
const checkupBusy = atom({ plugin: 'ruletree', key: 'checkupBusy' } as const, 0, { shape: 'checkupBusy-1' })
// 体检同时问几块、一块最多等多久（同 R1.2：60 秒 + 每条 2 秒，最多 240 秒，超时按 1.5 倍再试一次）
const CHECKUP_JOBS = 3
const timeoutFor = (rules: number) => Math.min(60000 + 2000 * rules, 240000)
// 计数减一，不到负数：session.start 清零后，上一轮没跑完的活回来还会减一次
const release = (n: number) => Math.max(0, n - 1)

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
    const lang = (await read($, snapshot))?.lang
    await update($, error, () => describeRunError(err, 'read', lang))
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
    const lang = (await read($, snapshot))?.lang
    await update($, error, () => strings(lang).refreshFailed(String(err).slice(0, 300)))
  }
}

// 改规则或撤销：同样放在顶层，因为校验器不让把 `$` 交给本地函数。
// JSON 走标准输入（$.process.run 的 stdin），不放进命令行，免得引号和中文出问题。
// node 是这次编辑所属的需求：结果回来时用户可能已选了别的格，话只挂在它名下。
// 不管结果如何都刷新；不是 done 就把 message 给用户看，并保留正在改的输入，别丢用户打的字。
export async function runEdit($: any, input: { ops: any[] } | { undo: string }, node: string) {
  // update 返回新值：大于 1 说明已有一次在跑，这次忽略
  if ((await update($, inflight, n => n + 1)) > 1) {
    await update($, inflight, release)
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
      message = describeRunError(err, 'edit', (await read($, snapshot))?.lang)
    }
    await update($, notice, () => ({ node, text: message }))
    await update($, armed, () => '')
    if (isDone) {
      await update($, editing, e => (e.node === node ? { node: '', text: '' } : e))
      if ('ops' in input && input.ops.some(o => o.op === 'add_rule')) await update($, addSeq, n => n + 1)
    }
  } finally {
    await update($, inflight, release)
  }
  await refresh($)
}

// 体检里问模型的一块：用会话自己的模型（haiku），不另起 claude 命令。顶层函数，因为校验器不让把 `$` 交给本地函数。
// 超时（aborted）就用 1.5 倍的时间再试一次；还不行或出错就返回 null，核心把这一块记成没问成，下次重问
export async function askBlock($: any, job: { prompt: string; rules: number }): Promise<string | null> {
  const ms = timeoutFor(job.rules)
  try {
    let r = await $.model.complete({ model: 'haiku', prompt: job.prompt, maxTokens: 4096, timeoutMs: ms })
    if (!r.isAnswered && r.reason === 'aborted') {
      r = await $.model.complete({ model: 'haiku', prompt: job.prompt, maxTokens: 4096, timeoutMs: Math.round(ms * 1.5) })
    }
    return r.isAnswered ? String(r.text) : null
  } catch {
    return null
  }
}

// 体检：核心在另一个进程里，调用不了 $.model.complete。所以先取提示词（--jobs，什么都不改），
// 在这里问模型（最多 3 块同时），再把答案交回去（--answers）由核心检查、改规则、写报告。
// 渲染只读 checkup 状态；写状态都在这里。失败时 snapshot 不动，地图还在。
export async function runCheckup($: any) {
  if ((await update($, checkupBusy, n => n + 1)) > 1) {
    await update($, checkupBusy, release)
    return
  }
  try {
    await update($, checkup, () => ({ phase: 'running', text: '', reason: '' }))
    let next: { phase: 'done' | 'failed'; text: string; reason: string }
    try {
      const cwd = await $.session.cwd()
      const bin = `${$.plugin.root}/bin/ruletree.js`
      const j = await $.process.run(['node', bin, 'checkup', cwd, '--jobs', '--json'], { timeoutMs: 120000 })
      if (j.exitCode !== 0) throw new Error(String(j.stderr).slice(0, 300) || `checkup exited ${j.exitCode}`)
      const jobs: { prompt: string; rules: number }[] = JSON.parse(j.stdout)
      const answers: { prompt: string; text: string }[] = []
      let at = 0
      const worker = async () => {
        while (at < jobs.length) {
          const job = jobs[at++]
          const text = await askBlock($, job)
          if (text !== null) answers.push({ prompt: job.prompt, text })
        }
      }
      await Promise.all(Array.from({ length: Math.min(CHECKUP_JOBS, jobs.length) }, worker))
      const r = await $.process.run(['node', bin, 'checkup', cwd, '--answers', '--json'], { stdin: JSON.stringify(answers), timeoutMs: 120000 })
      let out: any = null
      try { out = JSON.parse(r.stdout) } catch {}
      if (!out || !out.ok) throw new Error((out && out.message) || String(r.stderr).slice(0, 300) || `checkup exited ${r.exitCode}`)
      next = { phase: out.error ? 'failed' : 'done', text: String(out.report || ''), reason: String(out.error || '') }
    } catch (err) {
      next = { phase: 'failed', text: '', reason: describeCheckupError(err, (await read($, snapshot))?.lang) }
    }
    await update($, checkup, () => next)
  } finally {
    await update($, checkupBusy, release)
  }
  await refresh($) // 体检可能改了规则
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // 状态能活过插件重载，上一轮跑到一半的活却不会再回来：不清掉，这两个计数卡在非 0，按钮就再也按不动了
    await update($, inflight, () => 0)
    await update($, checkupBusy, () => 0)
    await update($, checkup, c => (c.phase === 'running' ? { phase: 'idle', text: '', reason: '' } : c))
    await $.command.register({ name: 'ruletree', description: 'Open the requirement map' })
    await refresh($)
    // Open unasked only where a pane docks beside the chat; the terminal stays quiet.
    if (e.surface && e.surface !== 'terminal') $.ui.open({ id: PANE, title: strings((await read($, snapshot))?.lang).paneTitle }).catch(() => {})
    // 慢速定时刷新：捕到会话外和子 agent 的改动
    $.clock.every(30000, () => {
      refresh($).catch(() => {})
    })
    return next(e)
  })

  on('command.run', { command: 'ruletree' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: strings((await read($, snapshot))?.lang).paneTitle })
    return { text: strings((await read($, snapshot))?.lang).opened }
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

  // 命令行里跑了需求树的程序（比如 /ruletree:setup）：改的不是 Edit/Write 能看到的文件，所以按命令内容刷新。
  // 同样先让命令跑完，后台刷新，AI 一点不被拖慢；不记 lastEdit（没有具体文件）
  for (const tool of ['Bash', 'PowerShell'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const ran = await next(e)
      if (String((e as any).command ?? '').includes('ruletree.js')) refresh($).catch(() => {})
      return ran
    }).catch(($, e, next) => next(e))
  }

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e) as any
    const props = (e as any).props
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
      checkup: await read($, checkup),
      surface: String((e as any).surface),
      // 哪个面上量不出尺寸时，按 60 列 40 行画，不至于排成一列
      cols: Number(props?.bodyColumns) || 60,
      rows: Number(props?.scroll?.bodyRows) || 40,
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
      onCheckup: async () => { await runCheckup($) },
      onCheckupClose: async () => { await update($, checkup, () => ({ phase: 'idle', text: '', reason: '' })) },
      onEditing: async (node, text) => {
        await update($, editing, () => ({ node: text ? node : '', text }))
        await update($, armed, () => '')
      },
    })
  })
}
