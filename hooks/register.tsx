import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Snapshot } from '../types'
import { paneTree } from './pane'

const PANE = 'ruletree-map'

// Atoms live here: the validator reads their plugin and key from this file.
const snapshot = atom({ plugin: 'ruletree', key: 'snapshot' } as const, null as Snapshot | null, { shape: 'snapshot-1' })
const selected = atom({ plugin: 'ruletree', key: 'selected' } as const, '', { shape: 'selected-1' })
const error = atom({ plugin: 'ruletree', key: 'error' } as const, '', { shape: 'error-1' })

// Top level on purpose: the validator rejects passing `$` to a local function.
export async function refresh($: any, file?: string) {
  const cwd = await $.session.cwd()
  const argv = ['node', `${$.plugin.root}/bin/ruletree.js`, 'snapshot', cwd, '--json']
  if (file) argv.push('--file', file)
  try {
    const r = await $.process.run(argv)
    if (r.exitCode !== 0) throw new Error(String(r.stderr).slice(0, 300))
    const data = JSON.parse(r.stdout)
    await update($, snapshot, () => data)
    await update($, error, () => '')
  } catch (err) {
    await update($, error, () => String(err).slice(0, 300))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ruletree', description: 'Open the requirement map' })
    await refresh($)
    // Open unasked only where a pane docks beside the chat; the terminal stays quiet.
    if (e.surface && e.surface !== 'terminal') void $.ui.open({ id: PANE, title: '需求树' })
    return next(e)
  })

  on('command.run', { command: 'ruletree' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: '需求树' })
    return { text: 'Requirement map opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e) as any
    return paneTree(Box, Text, await read($, snapshot), await read($, error))
  })
}
