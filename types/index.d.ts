export type SnapshotNode = {
  id: string
  title: string
  status: string | null
  children: SnapshotNode[]
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
  changes: unknown[]
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
      lastEdit: Shaped<{ file: string; at: number }>
      seq: Shaped<number>
    }
  }
}
