import type { Snapshot, SnapshotNode, SnapshotChange, OverviewTile } from '../types'

export const NODE_URL = 'https://nodejs.org'

// process.run 被拒有两种：命令起不来（多半没装 Node），或到点还没跑完（超时）。
// 类型里没有区分它们的字段，只能看错误文字：只有像「找不到可执行文件」的才说需要 Node.js，其余照实显示。
export function describeRunError(err: unknown, what: string): string {
  const msg = String((err as any)?.message ?? err)
  if (/ENOENT|not found|no such file|cannot find|找不到|无法启动|failed to (start|spawn)|cannot (start|spawn)/i.test(msg)) {
    return `需要 Node.js 才能${what}，请先安装（${NODE_URL}）。${msg.slice(0, 120)}`
  }
  return `${what}没成功：${msg.slice(0, 200)}`
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
const STATUS_WORD: Record<string, string> = { done: '完成', doing: '进行中', todo: '待做' }

export type PaneState = {
  snap: Snapshot | null
  err: string
  selected: string
  level: string
  surface: string
  // 等第二次按下才删的决定规则；正在改的规则；上一次编辑没完全成功时的话
  armed: string
  // 正在改哪个需求的哪条规则；上一次编辑没完全成功时的话（只在它所属的需求下显示）
  editing: { node: string; text: string }
  notice: { node: string; text: string }
  // 每成功加一条规则加一，用来换掉「加规则」输入框的 key，让它清空
  addSeq: number
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
}

// 决定类规则：用户拍板的，删它要按两次
export const isDecision = (text: string) => /^\s*(决定[：:]|decision\s*:)/i.test(text)

const STATUS_OPTIONS = [
  { value: '', label: '未标' },
  { value: 'todo', label: '待做' },
  { value: 'doing', label: '进行中' },
  { value: 'done', label: '完成' },
]
const RECENT_CHANGES = 3

// 详情：按下一格后画在地图下面。规则分组里自己的可以改、删；上级的只读
function detailView(els: any, node: SnapshotNode, st: PaneState, changes: SnapshotChange[], act: PaneActions) {
  const { Box, Text, Button, Select, Input } = els
  const { armed, editing, addSeq } = st
  const notice = st.notice.node === node.id ? st.notice.text : ''
  const undoable = changes.filter(c => c.undoable).slice(0, RECENT_CHANGES)
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="inactive" paddingX={1}>
      <Text bold>{`已选：${node.id} ${node.title}`}</Text>
      {notice ? <Text color="warning">{notice}</Text> : null}
      <Select
        key={`status-${node.id}`}
        label="状态："
        options={STATUS_OPTIONS}
        value={node.status ?? ''}
        onSelect={v => act.onEdit(node.id, [{ op: 'set_status', node: node.id, status: v || null }])}
      />
      <Text dimColor>{node.files.length ? `管：${node.files.join('、')}` : '没写管哪些文件（每次都会加载）'}</Text>
      {node.docs.length ? (
        <Text dimColor>{`文档：${node.docs.map(d => d.path + (d.ok ? '' : '（找不到）')).join('、')}`}</Text>
      ) : null}
      {node.groups.map(g => (
        <Box key={g.ownerId} flexDirection="column" marginTop={1}>
          <Text bold dimColor={!g.self}>{g.self ? '规则' : `来自 ${g.ownerId} ${g.ownerTitle}`}</Text>
          {g.rules.map((r, i) => {
            const k = `${g.ownerId}-${i}`
            const decision = isDecision(r.text)
            const asking = armed === r.text
            if (g.self && editing.node === node.id && editing.text === r.text) {
              return (
                <Box key={k} flexDirection="row">
                  <Input
                    key={`edit-${k}`}
                    value={r.text}
                    submitLabel="保存"
                    onSubmit={v => {
                      const text = v.trim()
                      if (text && text !== r.text) act.onEdit(node.id, [{ op: 'replace_rule', node: node.id, old: r.text, text }])
                      else act.onEditing(node.id, '')
                    }}
                  />
                  <Button key={`cancel-${k}`} onPress={() => act.onEditing(node.id, '')}>{'取消'}</Button>
                </Box>
              )
            }
            return (
              <Box key={k} flexDirection="row">
                <Text dimColor={!g.self} bold={decision}>{`- ${r.shown}`}</Text>
                {decision ? <Text color="claude">{' [决定]'}</Text> : null}
                {g.self ? (
                  <Box flexDirection="row" marginLeft={1}>
                    <Button key={`e-${k}`} plain onPress={() => act.onEditing(node.id, r.text)}>{'改'}</Button>
                    <Text>{' '}</Text>
                    <Button
                      key={`d-${k}`}
                      plain
                      onPress={() =>
                        decision && !asking
                          ? act.onArm(r.text)
                          : act.onEdit(node.id, [{ op: 'remove_rule', node: node.id, text: r.text }])
                      }
                    >
                      {asking ? '再按一次确认删除这条决定' : '删'}
                    </Button>
                  </Box>
                ) : null}
              </Box>
            )
          })}
        </Box>
      ))}
      <Input
        key={`add-${node.id}-${addSeq}`}
        label="加一条规则："
        placeholder="写完按 Enter"
        submitLabel="添加"
        onSubmit={v => {
          const text = v.trim()
          if (text) act.onEdit(node.id, [{ op: 'add_rule', node: node.id, text }])
        }}
      />
      {undoable.length ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{'最近的改动'}</Text>
          {undoable.map(c => (
            <Box key={c.id} flexDirection="row">
              <Text dimColor>{c.summary.join('；')}</Text>
              <Button key={`undo-${c.id}`} plain onPress={() => act.onUndo(node.id, c.id)}>{' 撤销'}</Button>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

// 全部是纯函数：只拿解析好的元素、普通数据和回调，不碰 `$` 和状态。
function header(Text: any, snap: Snapshot) {
  const t = snap.overview?.totals
  if (!t) return <Text bold>{snap.name}</Text>
  const none = t.none > 0 ? ` · 未标 ${t.none}` : ''
  return (
    <Text bold>{`${snap.name} · 完成 ${t.done} · 进行中 ${t.doing} · 待做 ${t.todo}${none}`}</Text>
  )
}

// 一格：外面的 Box 管边框和颜色，里面的 Button 管点击。
// 在改的用粗双线边框加「● 在改」，最近改过的用虚线，其余是圆角线。
function Tile(els: any, tile: OverviewTile, selected: string, act: PaneActions) {
  const { Box, Text, Button } = els
  const working = tile.state === 'working'
  const mark = tile.id === selected ? '▶ ' : ''
  return (
    <Box
      key={tile.id}
      borderStyle={working ? 'double' : tile.state === 'recent' ? 'dashed' : 'round'}
      borderColor={working ? 'claude' : colorOf(tile.status)}
      paddingX={1}
      marginRight={1}
    >
      <Button key={`b-${tile.id}`} plain onPress={() => act.onTile(tile)}>
        <Text bold={working} color={colorOf(tile.status)}>{`${mark}${tile.id} ${tile.title}`}</Text>
        {working ? <Text color="claude" bold>{' ● 在改'}</Text> : null}
        {tile.hasChildren ? <Text dimColor>{' ›'}</Text> : null}
      </Button>
    </Box>
  )
}

function Hint(Text: any, text: string, color?: string) {
  return <Text color={color} dimColor={!color}>{text}</Text>
}

// 终端文字树最多画几行，免得大项目刷满屏；在改的一行总是留着
export const TEXT_ROWS = 40

// 终端：缩进的文字树，没有按钮
function textTree(els: any, snap: Snapshot, selected: string) {
  const { Box, Text } = els
  const all = flatten(snap.nodes)
  const rows = all.slice(0, TEXT_ROWS)
  const w = all.findIndex(r => r.n.id === snap.working)
  if (w >= TEXT_ROWS) rows[TEXT_ROWS - 1] = all[w]
  const more = all.length - rows.length
  return (
    <Box flexDirection="column">
      {header(Text, snap)}
      {rows.map(({ n, depth }) => (
        <Text key={n.id} color={colorOf(n.status)} bold={n.id === snap.working}>
          {`${'  '.repeat(depth)}${n.id === selected ? '▶ ' : ''}${n.id} ${n.title}${n.status ? ` [${STATUS_WORD[n.status] ?? n.status}]` : ''}${n.id === snap.working ? ' ● 在改' : ''}`}
        </Text>
      ))}
      {more > 0 ? <Text dimColor>{`还有 ${more} 个`}</Text> : null}
    </Box>
  )
}

// 总览：块（顶层需求）里放格（下一级）
function overviewView(els: any, snap: Snapshot, selected: string, act: PaneActions) {
  const { Box, Text } = els
  const ov = snap.overview
  if (!ov) return Hint(Text, '...')
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap">
        {ov.blocks.map(b => (
          <Box key={b.id} flexDirection="column" flexGrow={b.span} marginRight={2} marginBottom={1}>
            <Text bold color={colorOf(b.status)}>{`${b.id} ${b.title}`}</Text>
            <Box flexDirection="row" flexWrap="wrap">
              {b.tiles.map(t => Tile(els, t, selected, act))}
              {b.hidden > 0 ? <Text dimColor>{`+${b.hidden}`}</Text> : null}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

// 更深一层：从 snap.nodes 里读，总览本身只有两层
function levelView(els: any, snap: Snapshot, level: string, selected: string, act: PaneActions) {
  const { Box, Text, Button } = els
  const hit = locate(snap.nodes, level)
  if (!hit) return overviewView(els, snap, selected, act)
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
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Button key="back" onPress={() => act.onBack(back)}>{'‹ 返回'}</Button>
        <Text bold color={colorOf(hit.node.status)}>{`  ${hit.node.id} ${hit.node.title}`}</Text>
      </Box>
      <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
        {tiles.map(t => Tile(els, t, selected, act))}
      </Box>
    </Box>
  )
}

export function paneTree(els: { Box: any; Text: any; Button: any; Select: any; Input: any }, st: PaneState, act: PaneActions) {
  const { Box, Text } = els
  const { snap, err, selected, level, surface } = st
  // 刷新失败：保留上一次好的地图，把原因放在上面。没有地图可保留时只有原因。
  const reason = err ? <Text color="error">{err}</Text> : null
  if (!snap) return err ? reason : Hint(Text, '...')
  if (!snap.enabled) {
    return (
      <Box flexDirection="column">
        {reason}
        <Text>这个项目还没有启用需求树。</Text>
        <Text>在输入框里输入 /ruletree:setup，让 AI 读一遍项目并提议一棵树，你确认后启用。</Text>
      </Box>
    )
  }
  const picked = selected ? locate(snap.nodes, selected)?.node : null
  return (
    <Box flexDirection="column">
      {reason}
      {surface === 'terminal' ? (
        textTree(els, snap, selected)
      ) : (
        <Box flexDirection="column">
          {header(Text, snap)}
          <Box marginTop={1} flexDirection="column">
            {level ? levelView(els, snap, level, selected, act) : overviewView(els, snap, selected, act)}
          </Box>
        </Box>
      )}
      {picked ? (surface === 'terminal' ? <Text>{`已选：${picked.id} ${picked.title}`}</Text> : detailView(els, picked, st, snap.changes, act)) : null}
    </Box>
  )
}
