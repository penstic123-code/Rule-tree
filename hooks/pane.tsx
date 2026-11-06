import type { Snapshot, SnapshotNode, SnapshotChange, OverviewTile } from '../types'

export const NODE_URL = 'https://nodejs.org'

export type Lang = 'zh' | 'en'

// 面板上所有固定文字都在这一张表里：按项目语言（snapshot.lang）取。没有项目或没有规则时用英文。
// 规则本身、需求标题、文件名是项目自己的字，不在这里。
const STR = {
  zh: {
    sep: '、',
    sep2: '；',
    needNode: (what: string, url: string, msg: string) => `需要 Node.js 才能${what}，请先安装（${url}）。${msg}`,
    failed: (what: string, msg: string) => `${what}没成功：${msg}`,
    whatRead: '读需求树',
    whatEdit: '改需求树',
    refreshFailed: (msg: string) => `刷新失败，下面是上一次的地图：${msg}`,
    loading: '正在读项目…',
    emptyMap: '树里还没有需求。在聊天里让 AI 按模块拆出第一批需求，它们会出现在这里。',
    working: ' ● 在改',
    recentTag: ' 刚改',
    workingNow: (id: string, title: string) => `● AI 在改：${id} ${title}`,
    done: '完成', doing: '进行中', todo: '待做', none: '未标',
    totals: (d: number, g: number, t: number, n: string) => `✓ 完成 ${d} · ◐ 进行中 ${g} · ○ 待做 ${t}${n}`,
    noneTotal: (n: number) => ` · 未标 ${n}`,
    selected: (id: string, title: string) => `已选：${id} ${title}`,
    statusLabel: '状态：',
    covers: (files: string) => `管：${files}`,
    coversNothing: '没写管哪些文件（每次都会加载）',
    docs: (list: string) => `文档：${list}`,
    docGone: '（找不到）',
    rules: '规则',
    from: (id: string, title: string) => `来自 ${id} ${title}`,
    decisionTag: ' [决定]',
    save: '保存', cancel: '取消', edit: '改', del: '删',
    confirmDel: '再按一次确认删除这条决定',
    addLabel: '加一条规则：',
    addPlaceholder: '写完按 Enter',
    add: '添加',
    recent: '最近的改动',
    undo: '撤销',
    more: (n: number) => `还有 ${n} 个`,
    back: '‹ 返回',
    notEnabled: '这个项目还没有启用需求树',
    enablePitch: '启用后，这里会画出项目的全貌：有哪些部分、各做到哪了、AI 正在改哪里。',
    enableStep: '在聊天输入框里输入：',
    enableAfter: 'AI 会读一遍项目，提议一棵树，你确认后才启用。',
    paneTitle: '需求树',
    opened: '需求树已打开。',
    checkup: '体检',
    checkupHint: '查规则有没有重复、矛盾、过时',
    checking: '体检中…',
    checkingHint: '通常要一两分钟，地图照常更新',
    checkupFailed: (msg: string) => `体检没成功：${msg}`,
    checkupTimedOut: '等太久了，再按一次体检试试',
    closeReport: '收起',
  },
  en: {
    sep: ', ',
    sep2: '; ',
    needNode: (what: string, url: string, msg: string) => `Node.js is needed to ${what}. Please install it first (${url}). ${msg}`,
    failed: (what: string, msg: string) => `Could not ${what}: ${msg}`,
    whatRead: 'read the requirement tree',
    whatEdit: 'edit the requirement tree',
    refreshFailed: (msg: string) => `Refresh failed; showing the last good map: ${msg}`,
    loading: 'Reading the project…',
    emptyMap: 'No requirements yet. Ask the AI in the chat to split the project into its first requirements, and they will appear here.',
    working: ' ● editing',
    recentTag: ' just edited',
    workingNow: (id: string, title: string) => `● AI is editing: ${id} ${title}`,
    done: 'Done', doing: 'In progress', todo: 'To do', none: 'No status',
    totals: (d: number, g: number, t: number, n: string) => `✓ Done ${d} · ◐ In progress ${g} · ○ To do ${t}${n}`,
    noneTotal: (n: number) => ` · No status ${n}`,
    selected: (id: string, title: string) => `Selected: ${id} ${title}`,
    statusLabel: 'Status: ',
    covers: (files: string) => `Covers: ${files}`,
    coversNothing: 'No paths set (its rules load every time)',
    docs: (list: string) => `Docs: ${list}`,
    docGone: ' (not found)',
    rules: 'Rules',
    from: (id: string, title: string) => `From ${id} ${title}`,
    decisionTag: ' [Decision]',
    save: 'Save', cancel: 'Cancel', edit: 'Edit', del: 'Delete',
    confirmDel: 'Press again to delete this decision',
    addLabel: 'Add a rule: ',
    addPlaceholder: 'Press Enter when done',
    add: 'Add',
    recent: 'Recent changes',
    undo: 'Undo',
    more: (n: number) => `${n} more`,
    back: '‹ Back',
    notEnabled: 'This project does not use a requirement tree yet',
    enablePitch: 'Once it is on, this pane maps the whole project: its parts, how far along each one is, and where the AI is working.',
    enableStep: 'Type this in the chat input box:',
    enableAfter: 'The AI reads the project and proposes a tree. Nothing is enabled until you approve it.',
    paneTitle: 'Requirement map',
    opened: 'Requirement map opened.',
    checkup: 'Checkup',
    checkupHint: 'Look for repeated, conflicting or stale rules',
    checking: 'Checking…',
    checkingHint: 'Usually a minute or two. The map keeps updating.',
    checkupFailed: (msg: string) => `The checkup did not work: ${msg}`,
    checkupTimedOut: 'It took too long. Press Checkup to try again.',
    closeReport: 'Hide',
  },
}
export const strings = (lang?: string | null) => (lang === 'zh' ? STR.zh : STR.en)

// process.run 被拒有两种：命令起不来（多半没装 Node），或到点还没跑完（超时）。
// 类型里没有区分它们的字段，只能看错误文字：只有像「找不到可执行文件」的才说需要 Node.js，其余照实显示。
export function describeRunError(err: unknown, what: 'read' | 'edit', lang?: string | null): string {
  const t = strings(lang)
  const w = what === 'read' ? t.whatRead : t.whatEdit
  const msg = String((err as any)?.message ?? err)
  if (/ENOENT|not found|no such file|cannot find|找不到|无法启动|failed to (start|spawn)|cannot (start|spawn)/i.test(msg)) {
    return t.needNode(w, NODE_URL, msg.slice(0, 120))
  }
  return t.failed(w, msg.slice(0, 200))
}

// 体检没跑成时给人看的原因。超时的原文带毫秒数，R1.2 不让报告列原始数字，所以换成一句人话
export function describeCheckupError(err: unknown, lang?: string | null): string {
  const msg = String((err as any)?.message ?? err)
  return /timed? ?out|超时/i.test(msg) ? strings(lang).checkupTimedOut : msg.slice(0, 300)
}

// 一个字占几格：中文和全角字两格，组合符号不占格。面板的宽度按格算，按字数截中文会撑破格子
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u
const ZERO = /[\u0300-\u036F\u200B-\u200D\uFE00-\uFE0F]/u
const charCells = (ch: string) => (ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1)
export const cellsOf = (s: string) => [...s].reduce((n, ch) => n + charCells(ch), 0)

// 截到 room 格以内，放不下时末尾是省略号。Text 的 wrap 也会截，但桌面的按钮里截不截类型没有保证，所以这里先截好
export function fit(s: string, room: number): string {
  if (cellsOf(s) <= room) return s
  if (room <= 0) return ''
  let out = ''
  let used = 0
  for (const ch of s) {
    used += charCells(ch)
    if (used > room - 1) break
    out += ch
  }
  return `${out}…`
}

function flatten(list: SnapshotNode[], depth = 0): { n: SnapshotNode; depth: number }[] {
  return list.flatMap(n => [{ n, depth }, ...flatten(n.children, depth + 1)])
}

// 找到某个需求和它的上一级编号（根 P 的上一级是 ''）
export function locate(list: SnapshotNode[], id: string, parent = ''): { node: SnapshotNode; parent: string } | null {
  for (const n of list) {
    if (n.id === id) return { node: n, parent }
    const hit = locate(n.children, id, n.id)
    if (hit) return hit
  }
  return null
}

function pathTo(list: SnapshotNode[], id: string): string[] {
  for (const n of list) {
    if (n.id === id) return [n.id]
    const rest = pathTo(n.children, id)
    if (rest.length) return [n.id, ...rest]
  }
  return []
}

const contains = (n: SnapshotNode, id: string | null): boolean =>
  !!id && (n.id === id || n.children.some(c => contains(c, id)))

// 状态色：用主题色名，跟着应用的深浅色走
const STATUS_COLOR: Record<string, string> = { done: 'success', doing: 'warning', todo: 'inactive' }
const colorOf = (s: string | null) => STATUS_COLOR[s ?? ''] ?? 'inactive'
// 状态记号：只靠颜色分不清（色弱、主题改色），每格都带一个；总数那行同时充当图例
const STATUS_GLYPH: Record<string, string> = { done: '✓', doing: '◐', todo: '○' }
const glyphOf = (s: string | null) => STATUS_GLYPH[s ?? ''] ?? '·'

// 一格至少这么宽才放得下记号、编号和一个看得出意思的标题；60 列的面板正好两列
const TILE_MIN = 28
const MAX_TILE_COLUMNS = 4
export const tileColumns = (cols: number) => Math.max(1, Math.min(MAX_TILE_COLUMNS, Math.floor(cols / TILE_MIN)))
const tileWidth = (cols: number) => {
  const n = tileColumns(cols)
  return Math.floor((cols - (n - 1)) / n)
}

type BlockShape = { id: string; tiles: { id: string }[]; hidden: number }
// 没有下一级的块，格就是它自己：只画这一格，别把同一个标题画两遍
const soloTile = (b: BlockShape) => b.tiles.length === 1 && b.tiles[0].id === b.id && b.hidden === 0
// 总览占几行（块标题加格子行，不算块之间的空行）。放得下才留空行：一屏看全比留白要紧
export function mapRows(blocks: BlockShape[], cols: number): number {
  const n = tileColumns(cols)
  return blocks.reduce((rows, b) => rows + (soloTile(b) ? 1 : 1 + Math.ceil((b.tiles.length + (b.hidden > 0 ? 1 : 0)) / n)), 0)
}
// 总览以外还要占的行：总数、在改、地图上方的空行、体检上方的空行、体检按钮
const CHROME_ROWS = 5

export type PaneState = {
  snap: Snapshot | null
  err: string
  selected: string
  level: string
  surface: string
  // 面板内容区有多宽多高（格）：格子的宽度和标题截到哪都按它算，窗口变宽时格子跟着多排几列
  cols: number
  rows: number
  // 等第二次按下才删的决定规则；正在改的规则；上一次编辑没完全成功时的话
  armed: string
  // 正在改哪个需求的哪条规则；上一次编辑没完全成功时的话（只在它所属的需求下显示）
  editing: { node: string; text: string }
  notice: { node: string; text: string }
  // 每成功加一条规则加一，用来换掉「加规则」输入框的 key，让它清空
  addSeq: number
  // 体检：idle 没在跑；running 在跑；done 有报告；failed 没跑成（reason 是原因，text 可能是报告）
  checkup: { phase: 'idle' | 'running' | 'done' | 'failed'; text: string; reason: string }
}
export type PaneActions = {
  // 按下一格：记住选中；有下一层就进到那一层
  onTile: (tile: { id: string; hasChildren: boolean }) => void
  onBack: (to: string) => void
  // 改规则或状态；撤销一条改动；记下「再按一次才删」的决定规则；记下正在改的规则（空串取消）
  onEdit: (node: string, ops: any[]) => void
  onUndo: (node: string, id: string) => void
  onArm: (text: string) => void
  onEditing: (node: string, text: string) => void
  // 按体检；收起报告
  onCheckup: () => void
  onCheckupClose: () => void
}

// 决定类规则：用户拍板的，删它要按两次
export const isDecision = (text: string) => /^\s*(决定[：:]|decision\s*:)/i.test(text)

const statusOptions = (t: ReturnType<typeof strings>) => [
  { value: '', label: t.none },
  { value: 'todo', label: t.todo },
  { value: 'doing', label: t.doing },
  { value: 'done', label: t.done },
]
const RECENT_CHANGES = 3

// 详情：按下一格后画在地图下面。规则分组里自己的可以改、删；上级的只读
function detailView(els: any, node: SnapshotNode, st: PaneState, changes: SnapshotChange[], act: PaneActions) {
  const t = strings(st.snap?.lang)
  const { Box, Text, Button, Select, Input } = els
  const { armed, editing, addSeq } = st
  const notice = st.notice.node === node.id ? st.notice.text : ''
  const undoable = changes.filter(c => c.undoable).slice(0, RECENT_CHANGES)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{t.selected(node.id, node.title)}</Text>
      {notice ? <Text color="warning">{notice}</Text> : null}
      <Select
        key={`status-${node.id}`}
        label={t.statusLabel}
        options={statusOptions(t)}
        value={node.status ?? ''}
        onSelect={v => act.onEdit(node.id, [{ op: 'set_status', node: node.id, status: v || null }])}
      />
      <Text dimColor>{node.files.length ? t.covers(node.files.join(t.sep)) : t.coversNothing}</Text>
      {node.docs.length ? (
        <Text dimColor>{t.docs(node.docs.map(d => d.path + (d.ok ? '' : t.docGone)).join(t.sep))}</Text>
      ) : null}
      {node.groups.map(g => (
        <Box key={g.ownerId} flexDirection="column" marginTop={1}>
          <Text bold dimColor={!g.self}>{g.self ? t.rules : t.from(g.ownerId, g.ownerTitle)}</Text>
          {g.rules.map((r, i) => {
            const k = `${g.ownerId}-${i}`
            const decision = isDecision(r.text)
            const asking = armed === r.text
            if (g.self && editing.node === node.id && editing.text === r.text) {
              return (
                <Box key={k} flexDirection="row" columnGap={1}>
                  <Input
                    key={`edit-${k}`}
                    value={r.text}
                    submitLabel={t.save}
                    onSubmit={v => {
                      const text = v.trim()
                      if (text && text !== r.text) act.onEdit(node.id, [{ op: 'replace_rule', node: node.id, old: r.text, text }])
                      else act.onEditing(node.id, '')
                    }}
                  />
                  <Button key={`cancel-${k}`} onPress={() => act.onEditing(node.id, '')}>{t.cancel}</Button>
                </Box>
              )
            }
            return (
              <Box key={k} flexDirection="row" columnGap={1}>
                {/* 规则长时自己折行，按钮不被挤走 */}
                <Box flexDirection="row" flexGrow={1} flexShrink={1}>
                  <Text dimColor={!g.self} bold={decision}>
                    {`- ${r.shown}`}
                    {decision ? <Text color="claude">{t.decisionTag}</Text> : null}
                  </Text>
                </Box>
                {g.self ? (
                  <Box flexDirection="row" flexShrink={0} columnGap={1}>
                    <Button key={`e-${k}`} plain onPress={() => act.onEditing(node.id, r.text)}>{t.edit}</Button>
                    <Button
                      key={`d-${k}`}
                      plain
                      onPress={() =>
                        decision && !asking
                          ? act.onArm(r.text)
                          : act.onEdit(node.id, [{ op: 'remove_rule', node: node.id, text: r.text }])
                      }
                    >
                      {asking ? t.confirmDel : t.del}
                    </Button>
                  </Box>
                ) : null}
              </Box>
            )
          })}
        </Box>
      ))}
      <Box marginTop={1}>
        <Input
          key={`add-${node.id}-${addSeq}`}
          label={t.addLabel}
          placeholder={t.addPlaceholder}
          submitLabel={t.add}
          onSubmit={v => {
            const text = v.trim()
            if (text) act.onEdit(node.id, [{ op: 'add_rule', node: node.id, text }])
          }}
        />
      </Box>
      {undoable.length ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{t.recent}</Text>
          {undoable.map(c => (
            <Box key={c.id} flexDirection="row" columnGap={1}>
              <Box flexDirection="row" flexGrow={1} flexShrink={1}>
                <Text dimColor>{c.summary.join(t.sep2)}</Text>
              </Box>
              <Box flexShrink={0}>
                <Button key={`undo-${c.id}`} plain onPress={() => act.onUndo(node.id, c.id)}>{t.undo}</Button>
              </Box>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

// 全部是纯函数：只拿解析好的元素、普通数据和回调，不碰 `$` 和状态。
// 总数行是全图第一行。项目名太长时不挤掉总数：放不下一行就分两行
function header(els: any, snap: Snapshot, cols: number) {
  const { Box, Text } = els
  const name = fit(snap.name, cols)
  const t = snap.overview?.totals
  if (!t) return <Text bold>{name}</Text>
  const w = strings(snap.lang)
  const line = w.totals(t.done, t.doing, t.todo, t.none > 0 ? w.noneTotal(t.none) : '')
  const fits = cellsOf(name) + 2 + cellsOf(line) <= cols
  return (
    <Box flexDirection={fits ? 'row' : 'column'} columnGap={2}>
      <Text bold>{name}</Text>
      <Text>{line}</Text>
    </Box>
  )
}

// 一格占一行，不画边框：桌面的 Button 自己就是原生按钮，再套边框要多花两行，48 格就放不进一屏。
// 在改的格整段反色加粗，是全图唯一的实色块，眼睛先落在这里；反色没画出来时还有粗体、● 和「在改」两个字
function Tile(els: any, tile: OverviewTile, selected: string, act: PaneActions, lang: string | undefined, width: number) {
  const { Box, Text, Button } = els
  const t = strings(lang)
  const working = tile.state === 'working'
  const tag = working ? t.working : tile.state === 'recent' ? t.recentTag : ''
  const more = tile.hasChildren ? ' ›' : ''
  const mark = tile.id === selected ? '▶ ' : ''
  const name = fit(`${mark}${glyphOf(tile.status)} ${tile.id} ${tile.title}`, width - cellsOf(tag) - cellsOf(more))
  const word = tile.status ? (t as any)[tile.status] ?? tile.status : t.none
  return (
    <Box key={tile.id} width={width} flexShrink={0} overflow="hidden">
      {/* 字截短了，label 留全名给读屏 */}
      <Button key={`b-${tile.id}`} plain label={`${tile.id} ${tile.title} · ${word}${tag}`} onPress={() => act.onTile(tile)}>
        {working ? (
          <Text bold inverse color="claude" wrap="truncate-end">{`${name}${tag}`}</Text>
        ) : (
          <Text color={colorOf(tile.status)} wrap="truncate-end">{name}</Text>
        )}
        {!working && tag ? <Text color="claude">{tag}</Text> : null}
        {more ? <Text dimColor>{more}</Text> : null}
      </Button>
    </Box>
  )
}

// 格子排成固定的列，一行一个 Box：不靠换行排版，两列就一定是两列，宽度也都按 cols 算好
function tileGrid(els: any, id: string, tiles: OverviewTile[], hidden: number, selected: string, act: PaneActions, lang: string | undefined, cols: number) {
  const { Box, Text } = els
  const n = tileColumns(cols)
  const width = tileWidth(cols)
  const cells = tiles.map(t => Tile(els, t, selected, act, lang, width))
  if (hidden > 0) cells.push(<Text key={`more-${id}`} dimColor>{strings(lang).more(hidden)}</Text>)
  const rows = Array.from({ length: Math.ceil(cells.length / n) }, (_, i) => cells.slice(i * n, (i + 1) * n))
  return rows.map((row, i) => (
    <Box key={`row-${id}-${i}`} flexDirection="row" columnGap={1}>{row}</Box>
  ))
}

// 块标题：记号、编号、标题，右边是这一块的下一级完成了几个（藏起来的格也算，总览只列得下一部分）
function blockTitle(els: any, node: { id: string; title: string; status: string | null }, nodes: SnapshotNode[], cols: number) {
  const { Box, Text } = els
  const kids = locate(nodes, node.id)?.node.children ?? []
  const progress = kids.length ? `${kids.filter(k => k.status === 'done').length}/${kids.length}` : ''
  const room = cols - (progress ? cellsOf(progress) + 1 : 0)
  return (
    <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
      <Text bold color={colorOf(node.status)} wrap="truncate-end">{fit(`${glyphOf(node.status)} ${node.id} ${node.title}`, room)}</Text>
      {progress ? <Text dimColor>{progress}</Text> : null}
    </Box>
  )
}

function Hint(Text: any, text: string, color?: string) {
  return <Text color={color} dimColor={!color}>{text}</Text>
}

// 终端文字树最多画几行，免得大项目刷满屏；在改的一行总是留着
export const TEXT_ROWS = 40

// 终端：缩进的文字树，没有按钮
function textTree(els: any, snap: Snapshot, selected: string, cols: number) {
  const { Box, Text } = els
  const tr = strings(snap.lang)
  const all = flatten(snap.nodes)
  const rows = all.slice(0, TEXT_ROWS)
  const w = all.findIndex(r => r.n.id === snap.working)
  if (w >= TEXT_ROWS) rows[TEXT_ROWS - 1] = all[w]
  const more = all.length - rows.length
  return (
    <Box flexDirection="column">
      {header(els, snap, cols)}
      {rows.map(({ n, depth }) => (
        <Text key={n.id} color={colorOf(n.status)} bold={n.id === snap.working}>
          {`${'  '.repeat(depth)}${n.id === selected ? '▶ ' : ''}${n.id} ${n.title}${n.status ? ` [${(tr as any)[n.status] ?? n.status}]` : ''}${n.id === snap.working ? tr.working : ''}`}
        </Text>
      ))}
      {more > 0 ? <Text dimColor>{tr.more(more)}</Text> : null}
    </Box>
  )
}

// 总览：块（顶层需求）里放格（下一级）。块竖着排、占满宽：格子多的块自然更高，大小就是它在项目里的分量
function overviewView(els: any, snap: Snapshot, selected: string, act: PaneActions, cols: number, rows: number) {
  const { Box, Text } = els
  const blocks = snap.overview?.blocks ?? []
  if (!blocks.length) return Hint(Text, strings(snap.lang).emptyMap)
  const air = mapRows(blocks, cols) + blocks.length - 1 + CHROME_ROWS <= rows ? 1 : 0
  return (
    <Box flexDirection="column" rowGap={air}>
      {blocks.map(b => (
        <Box key={b.id} flexDirection="column">
          {soloTile(b) ? Tile(els, b.tiles[0] as OverviewTile, selected, act, snap.lang, cols) : blockTitle(els, b, snap.nodes, cols)}
          {soloTile(b) ? null : tileGrid(els, b.id, b.tiles, b.hidden, selected, act, snap.lang, cols)}
        </Box>
      ))}
    </Box>
  )
}

// 更深一层：从 snap.nodes 里读，总览本身只有两层
function levelView(els: any, snap: Snapshot, level: string, selected: string, act: PaneActions, cols: number, rows: number) {
  const { Box, Button } = els
  const hit = locate(snap.nodes, level)
  if (!hit) return overviewView(els, snap, selected, act, cols, rows)
  // 路径是 根 P > 块 > 格 > 更深。总览已经画了块和格，所以从「格」的下一层起才回到上一级，其余回总览
  const path = pathTo(snap.nodes, level)
  const back = path.length >= 4 ? path[path.length - 2] : ''
  const tiles: OverviewTile[] = hit.node.children.map(c => ({
    id: c.id,
    title: c.title,
    status: c.status,
    state: contains(c, snap.working) ? 'working' : null,
    hasChildren: c.children.length > 0,
  }))
  const label = strings(snap.lang).back
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={2}>
        <Box flexShrink={0}>
          <Button key="back" onPress={() => act.onBack(back)}>{label}</Button>
        </Box>
        <Box flexGrow={1} flexDirection="column">
          {/* 留出按钮本身的边：终端画成 [ 返回 ]，桌面是原生按钮，都比文字宽 */}
          {blockTitle(els, hit.node, snap.nodes, cols - cellsOf(label) - 6)}
        </Box>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {tileGrid(els, level, tiles, 0, selected, act, snap.lang, cols)}
      </Box>
    </Box>
  )
}

// 报告是核心写的 markdown，前三行（去掉空行后）是标题、日期、带数字的总结：面板不画，R1.2 不列原始数字。
// 这是和 src/checkup.js 的 report() 的约定，test/checkup.test.js 和 pane.test.tsx 都钉着它
export const REPORT_HEAD_LINES = 3
export const reportBody = (text: string) => text.split('\n').filter(l => l.trim()).slice(REPORT_HEAD_LINES)

// 体检按钮和报告。小标题加粗，其余原样。
// 报告里已经写了没跑成的原因（而且是报告的语言），所以有报告时不再单独列 reason，免得同一句话出现两遍
function checkupView(els: any, st: PaneState, act: PaneActions) {
  const { Box, Text, Button } = els
  const t = strings(st.snap?.lang)
  const { phase, text, reason } = st.checkup
  const lines = reportBody(text)
  const failed = phase === 'failed'
  const hint = phase === 'running' ? t.checkingHint : phase === 'idle' ? t.checkupHint : ''
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" columnGap={2}>
        <Box flexShrink={0}>
          <Button key="checkup" onPress={() => act.onCheckup()}>{phase === 'running' ? t.checking : t.checkup}</Button>
        </Box>
        {phase === 'done' || failed ? (
          <Button key="checkup-close" plain onPress={() => act.onCheckupClose()}>{t.closeReport}</Button>
        ) : null}
        {hint ? <Text dimColor wrap="truncate-end">{hint}</Text> : null}
      </Box>
      {reason && !lines.length ? <Text color="error">{t.checkupFailed(reason)}</Text> : null}
      {lines.map((l, i) =>
        l.startsWith('#') ? (
          <Box key={`ck-${i}`} marginTop={1}><Text bold>{l.replace(/^#+\s*/, '')}</Text></Box>
        ) : (
          <Text key={`ck-${i}`} color={failed && i === 0 ? 'error' : undefined}>{l}</Text>
        )
      )}
    </Box>
  )
}

// 还没启用：说清启用后能看到什么，命令单独占一行，是这里唯一要做的事
function notEnabledView(els: any, lang?: string) {
  const { Box, Text } = els
  const t = strings(lang)
  return (
    <Box flexDirection="column" rowGap={1}>
      <Text bold size="heading">{t.notEnabled}</Text>
      <Text>{t.enablePitch}</Text>
      <Box flexDirection="column">
        <Text>{t.enableStep}</Text>
        <Box marginLeft={2}><Text bold mono color="claude">/ruletree:setup</Text></Box>
      </Box>
      <Text dimColor>{t.enableAfter}</Text>
    </Box>
  )
}

export function paneTree(els: { Box: any; Text: any; Button: any; Select: any; Input: any }, st: PaneState, act: PaneActions) {
  const { Box, Text } = els
  const { snap, err, selected, level, surface, cols, rows } = st
  // 刷新失败：保留上一次好的地图，把原因放在上面。没有地图可保留时只有原因。
  const reason = err ? <Text color="error">{err}</Text> : null
  if (!snap) return err ? reason : Hint(Text, strings().loading)
  if (!snap.enabled) {
    return (
      <Box flexDirection="column">
        {reason}
        {notEnabledView(els, snap.lang)}
      </Box>
    )
  }
  const picked = selected ? locate(snap.nodes, selected)?.node : null
  const busy = snap.working ? locate(snap.nodes, snap.working)?.node : null
  return (
    <Box flexDirection="column">
      {reason}
      {surface === 'terminal' ? (
        textTree(els, snap, selected, cols)
      ) : (
        <Box flexDirection="column">
          {header(els, snap, cols)}
          {/* 进了下一层或那一格被收起时，地图上看不到在改的格，这一行总在 */}
          {busy ? <Text bold color="claude" wrap="truncate-end">{fit(strings(snap.lang).workingNow(busy.id, busy.title), cols)}</Text> : null}
          <Box marginTop={1} flexDirection="column">
            {level ? levelView(els, snap, level, selected, act, cols, rows) : overviewView(els, snap, selected, act, cols, rows)}
          </Box>
          {checkupView(els, st, act)}
        </Box>
      )}
      {picked ? (surface === 'terminal' ? <Text>{strings(snap.lang).selected(picked.id, picked.title)}</Text> : detailView(els, picked, st, snap.changes, act)) : null}
    </Box>
  )
}
