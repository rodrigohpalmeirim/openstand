import { beforeEach, describe, expect, it, vi } from 'vitest'

const load = async () => (await import('./nav')).useNav

describe('route persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.resetModules()
  })

  it('reopens the Settings section that was open, and returns to the last library section', async () => {
    let useNav = await load()
    useNav.getState().go({ name: 'library', section: 'artists', group: 'Bach' })
    useNav.getState().go({ name: 'settings', page: 'pedals' })
    vi.resetModules()
    useNav = await load()
    expect(useNav.getState().route).toEqual({ name: 'settings', page: 'pedals' })
    expect(useNav.getState().lastLibrary).toEqual({ name: 'library', section: 'artists', group: 'Bach' })
  })

  it('reopens the settings list, and forgets Settings once left', async () => {
    let useNav = await load()
    useNav.getState().go({ name: 'settings' })
    vi.resetModules()
    useNav = await load()
    expect(useNav.getState().route).toEqual({ name: 'settings', page: undefined })
    useNav.getState().go(useNav.getState().lastLibrary)
    vi.resetModules()
    useNav = await load()
    expect(useNav.getState().route).toEqual({ name: 'library', section: 'songs' })
  })

  it('starts in the library on a cold start or in another tab, even if Settings was open', async () => {
    let useNav = await load()
    useNav.getState().go({ name: 'library', section: 'setlists' })
    useNav.getState().go({ name: 'settings', page: 'pedals' })
    sessionStorage.clear() // a new tab / app launch: only local storage carries over
    vi.resetModules()
    useNav = await load()
    expect(useNav.getState().route).toEqual({ name: 'library', section: 'setlists' })
  })

  it('ignores a Settings route left in local storage by older versions', async () => {
    localStorage.setItem('openstand-route-settings', 'pedals')
    const useNav = await load()
    expect(useNav.getState().route).toEqual({ name: 'library', section: 'songs' })
    expect(localStorage.getItem('openstand-route-settings')).toBeNull()
  })
})
