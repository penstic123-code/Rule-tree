export type SnapshotNode = {
  id: string
  title: string
  status: string | null
  children: SnapshotNode[]
}

export type Snapshot = {
  enabled: boolean
  dir: string
  name: string
  nodes: SnapshotNode[]
  changes: unknown[]
  unmapped: unknown[]
  problems: unknown[]
  working: unknown
  overview: string
}

declare module 'claude-code' {
  interface PluginState {
    ruletree: {
      snapshot: Shaped<Snapshot | null>
      selected: Shaped<string>
      error: Shaped<string>
    }
  }
}
