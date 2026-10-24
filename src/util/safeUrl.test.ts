// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openExternalUrl, safeExternalUrl } from './safeUrl'

describe('safeExternalUrl', () => {
  it('keeps http and https URLs', () => {
    expect(safeExternalUrl('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c')
    expect(safeExternalUrl('http://example.com')).toBe('http://example.com/')
    expect(safeExternalUrl('  HTTPS://Example.com/x  ')).toBe('https://example.com/x')
  })

  it('adds https:// to bare addresses, including host:port', () => {
    expect(safeExternalUrl('example.com/score.pdf')).toBe('https://example.com/score.pdf')
    expect(safeExternalUrl('www.youtube.com/watch?v=1')).toBe('https://www.youtube.com/watch?v=1')
    expect(safeExternalUrl('localhost:8080/x')).toBe('https://localhost:8080/x')
    expect(safeExternalUrl('//example.com/x')).toBe('https://example.com/x')
  })

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    '\tjavascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'intent://scan/#Intent;scheme=zxing;end',
    'blob:https://example.com/uuid',
    'mailto:a@b.c',
    'tel:123',
    'spotify:track:123',
    'ms-settings:',
    'chrome://settings',
    'about:blank',
    'https://',
    '',
    '   ',
    undefined,
    null,
  ])('rejects %j', (raw) => {
    expect(safeExternalUrl(raw)).toBeNull()
  })
})

describe('openExternalUrl', () => {
  afterEach(() => vi.restoreAllMocks())

  it('opens safe URLs with noopener and refuses others', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    expect(openExternalUrl('example.com')).toBe(true)
    expect(open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer')
    expect(openExternalUrl('javascript:alert(document.domain)')).toBe(false)
    expect(openExternalUrl('intent://x#Intent;end')).toBe(false)
    expect(open).toHaveBeenCalledTimes(1)
  })
})
