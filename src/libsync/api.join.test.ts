import { describe, expect, it, vi } from 'vitest'

// The engine side of joining is covered by the flow tests; here only what the facade does around it.
vi.mock('./service', () => ({
  deviceName: () => 'Test device',
  setInitial: () => {},
  withEngineStopped: async (fn: () => Promise<unknown>) => fn(),
}))
vi.mock('./join', () => ({ join: async () => ({ stop() {} }) }))

const { joinSync } = await import('./api')
const { useLibraries } = await import('../library/browse/libraries')
const { useNav } = await import('../state/nav')

describe('joinSync as a new library', () => {
  it('switches to a new library but stays on the settings screen that started the join', async () => {
    // Regression: switching reset navigation to the library home, unmounting the join dialog mid-join.
    useNav.getState().go({ name: 'settings', page: 'libsync' })
    const before = useLibraries.getState().active
    await joinSync({ v: 1, s: 'x', n: 'My Library', b: { kind: 'memory', name: 't' } }, 'newLibrary')
    const { active, list } = useLibraries.getState()
    expect(active).not.toBe(before)
    expect(useNav.getState().route).toEqual({ name: 'settings', page: 'libsync' })
    // The local default library is also "My Library": the synced one gets a distinguishable name.
    expect(list.find((l) => l.id === active)?.name).toBe('My Library (synced)')
  })
})
