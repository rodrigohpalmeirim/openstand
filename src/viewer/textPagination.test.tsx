import { describe, expect, it } from 'vitest'
import { DEFAULT_TEXT_STYLE, type Block } from '../chordpro/render'
import { paginate } from './textPagination'

describe('paginate', () => {
  const blocks: Block[] = [
    { key: 'a', node: <p>verse 1</p> },
    { key: 'b', node: <p>verse 2</p>, breakBefore: 'column' },
    { key: 'c', node: <p>verse 3</p>, breakBefore: 'column' },
  ]
  const size = { width: 400, height: 800 }

  it('honours column breaks, turning the page when the columns are used up', () => {
    const pages = paginate(blocks, size, 1, DEFAULT_TEXT_STYLE, 1)
    expect(pages.map((p) => p.columns.map((c) => c.map((b) => b.key)))).toEqual([[['a']], [['b']], [['c']]])
  })

  it('ignores column breaks when asked (fewer columns fit than the file wants)', () => {
    const pages = paginate(blocks, size, 1, DEFAULT_TEXT_STYLE, 1, { columnBreaks: false })
    expect(pages.map((p) => p.columns.map((c) => c.map((b) => b.key)))).toEqual([[['a', 'b', 'c']]])
  })
})
