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
  // 写了范围却一个文件都匹配不到（做完了的不算）
  noMatch?: boolean
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

export type SnapshotProblem = { k: 'noId' | 'dupId' | 'noParent'; file: string; id?: string; other?: string; parent?: string }

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
  // 规则文件的问题：没有编号、编号重复、上级不存在（src/tree.js build）
  problems: SnapshotProblem[]
  // 正在改的文件所属的需求编号；没有就是 null
  working: string | null
  // 项目的语言：说明书、面板文字跟着它走。没有规则的项目是 'en'
  lang: 'zh' | 'en'
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
      notice: Shaped<{ node: string; text: string }>
      // 等第二次按下才删的决定规则原文
      armed: Shaped<string>
      // 正在改哪个需求的哪条规则原文
      editing: Shaped<{ node: string; text: string }>
      // 正在跑的编辑个数（防连按）；加规则成功次数（换 Input 的 key 清空它）
      inflight: Shaped<number>
      addSeq: Shaped<number>
      lastEdit: Shaped<{ file: string; at: number }>
      seq: Shaped<number>
      // 体检的阶段、报告、没跑成的原因；正在跑的体检个数（防连按）
      checkup: Shaped<{ phase: 'idle' | 'running' | 'done' | 'failed'; text: string; reason: string }>
      checkupBusy: Shaped<number>
    }
  }
}
