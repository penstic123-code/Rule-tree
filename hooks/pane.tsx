import type { Snapshot, SnapshotNode } from '../types'

function flatten(list: SnapshotNode[], depth = 0): { n: SnapshotNode; depth: number }[] {
  return list.flatMap(n => [{ n, depth }, ...flatten(n.children, depth + 1)])
}

// Skeleton only: a plain list of titles. The real map is Task 4.
// Pure: takes the resolved elements and plain data, never `$` or state.
export function paneTree(Box: any, Text: any, snap: Snapshot | null, err: string) {
  if (err) return <Text color="red">{err}</Text>
  if (!snap) return <Text dimColor>...</Text>
  if (!snap.enabled) return <Text dimColor>No requirement tree in this project.</Text>
  return (
    <Box flexDirection="column">
      {flatten(snap.nodes).map(({ n, depth }) => (
        <Text key={n.id}>{`${'  '.repeat(depth)}${n.id} ${n.title}${n.status ? ` ${n.status}` : ''}`}</Text>
      ))}
    </Box>
  )
}
