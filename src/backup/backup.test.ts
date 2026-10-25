import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { autoBackupPrefix, isAutoBackupOf } from './backup'

const STAMP = '2026-10-25-09-55.osbackup'

describe('automatic backup names', () => {
  it('prunes by library id, not by display name', () => {
    // "A/B" and "A B" both become "A_B": the id token keeps them apart.
    const a = autoBackupPrefix('a-b', '-A_B') + STAMP
    const b = autoBackupPrefix('a-b-2', '-A_B') + STAMP
    expect(isAutoBackupOf(a, 'a-b')).toBe(true)
    expect(isAutoBackupOf(b, 'a-b')).toBe(false)
    expect(isAutoBackupOf(a, 'a-b-2')).toBe(false)
  })

  it('still matches after a rename and for the default library', () => {
    expect(isAutoBackupOf(autoBackupPrefix('gigs', '-Old_name') + STAMP, 'gigs')).toBe(true)
    expect(isAutoBackupOf(autoBackupPrefix('default', '') + STAMP, 'default')).toBe(true)
    expect(isAutoBackupOf(autoBackupPrefix('default', '') + STAMP, 'gigs')).toBe(false)
  })

  it('also prunes the older id-only names of this library', () => {
    expect(isAutoBackupOf(`OpenStand-auto-${STAMP}`, 'default')).toBe(true)
    expect(isAutoBackupOf(`OpenStand-auto-gigs-${STAMP}`, 'gigs')).toBe(true)
    expect(isAutoBackupOf(`OpenStand-auto-gigs-${STAMP}`, 'default')).toBe(false)
    expect(isAutoBackupOf(`OpenStand-auto-${STAMP}`, 'gigs')).toBe(false)
    expect(isAutoBackupOf(`OpenStand-auto-gigs-${STAMP}.bak`, 'gigs')).toBe(false)
  })
})
