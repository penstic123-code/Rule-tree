import type { Snapshot, SnapshotNode, OverviewTile } from '../types'

export const NODE_URL = 'https://nodejs.org'

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
}
export type PaneActions = {
  // 按下一格：记住选中；有下一层就进到那一层
  onTile: (tile: { id: string; hasChildren: boolean }) => void
  onBack: (to: string) => void
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

export function paneTree(els: { Box: any; Text: any; Button: any }, st: PaneState, act: PaneActions) {
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
      {picked ? <Text>{`已选：${picked.id} ${picked.title}`}</Text> : null}
    </Box>
  )
}
