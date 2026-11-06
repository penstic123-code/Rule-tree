// 详情要的：一条规则（来自 src/viewmodel.js 的 ruleGroups）
export type SnapshotRule = {
  text: string
  shown: string
  // own 自己的、inherit 上级的、overrides 取代了上级、overridden 被下级取代
  state: 'own' | 'inherit' | 'overrides' | 'overridden'
}
export type SnapshotRuleGroup = {
  self: boolean
  ownerId: string
  ownerTitle: string
  rules: SnapshotRule[]
}
export type SnapshotNode = {
  id: string
  title: string
  status: string | null
  children: SnapshotNode[]
  // 管哪些文件（paths）
  files: string[]
  docs: { path: string; ok: boolean }[]
  groups: SnapshotRuleGroup[]
}
// 改动记录的一条（src/store.js changeSummaries）
export type SnapshotChange = {
  id: string
  time: number
  source: string
  summary: string[]
  undone: boolean
  undoable: boolean
}

// 以下三个类型对应 src/layout.js 的 overview() 返回值。
export type OverviewTile = {
  id: string
  title: string
  status: string | null
  // working：AI 正在改它或它的下级；recent：最近改过；null：无
  state: 'working' | 'recent' | null
  hasChildren: boolean
}

export type OverviewBlock = {
  id: string
  title: string
  status: string | null
  span: 1 | 2 | 3
  tiles: OverviewTile[]
  hidden: number
}

export type Overview = {
  totals: { done: number; doing: number; todo: number; none: number }
  blocks: OverviewBlock[]
}

export type Snapshot = {
  enabled: boolean
  dir: string
  name: string
  nodes: SnapshotNode[]
  changes: SnapshotChange[]
  unmapped: unknown[]
  problems: unknown[]
  // 正在改的文件所属的需求编号；没有就是 null
  working: string | null
  // 项目没启用时核心给 null
  overview: Overview | null
}

declare module 'claude-code' {
  interface PluginState {
    ruletree: {
      snapshot: Shaped<Snapshot | null>
      selected: Shaped<string>
      // 当前显示哪个需求的下一层；空字符串是总览
      level: Shaped<string>
      error: Shaped<string>
      // 编辑或撤销没完全成功时给用户看的话
      notice: Shaped<string>
      // 等第二次按下才删的决定规则原文
      armed: Shaped<string>
      // 正在改的规则原文
      editing: Shaped<string>
      lastEdit: Shaped<{ file: string; at: number }>
      seq: Shaped<number>
    }
  }
}
