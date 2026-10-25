import { renderToStaticMarkup } from 'react-dom/server'
import { textContainerStyle, type Block, type TextStyle } from '../chordpro/render'

export interface TextPage {
  /** Blocks per column. */
  columns: Block[][]
}

/** Inner padding of a text page as a fraction of the page width. */
export const TEXT_PAGE_PADDING = 0.05

/**
 * Wrapper style for every block, both when measuring and when rendering: a new block formatting
 * context keeps each block's margins inside its own box, so measured heights add up exactly.
 */
export const TEXT_BLOCK_STYLE = { display: 'flow-root' } as const

/**
 * Pack blocks into pages of the given CSS size. Each block is measured off-screen at the column width,
 * then greedily placed; explicit page breaks are honoured, column breaks too unless `columnBreaks` is
 * false, and headers stay with the next block.
 */
export function paginate(
  blocks: Block[],
  size: { width: number; height: number },
  columns: number,
  style: TextStyle,
  zoom: number,
  { columnBreaks = true }: { columnBreaks?: boolean } = {},
): TextPage[] {
  const pad = size.width * TEXT_PAGE_PADDING
  const gap = size.width * 0.04
  const colWidth = (size.width - pad * 2 - gap * (columns - 1)) / columns
  const colHeight = size.height - pad * 2
  if (colWidth <= 20 || colHeight <= 20) return [{ columns: [blocks] }]

  const host = document.createElement('div')
  Object.assign(host.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    width: `${colWidth}px`,
    visibility: 'hidden',
    contain: 'layout',
  })
  document.body.appendChild(host)
  const heights: number[] = []
  try {
    // Static markup keeps measurement synchronous (this runs during render, where flushSync can't).
    host.innerHTML = renderToStaticMarkup(
      <div style={textContainerStyle(style, zoom)}>
        {blocks.map((b) => (
          <div key={b.key} data-block="" style={TEXT_BLOCK_STYLE}>
            {b.node}
          </div>
        ))}
      </div>,
    )
    host.querySelectorAll<HTMLElement>('[data-block]').forEach((el) => heights.push(el.getBoundingClientRect().height))
  } finally {
    host.remove()
  }

  const pages: TextPage[] = []
  let page: TextPage = { columns: [[]] }
  let used = 0
  const newColumn = () => {
    if (page.columns.length < columns) page.columns.push([])
    else {
      pages.push(page)
      page = { columns: [[]] }
    }
    used = 0
  }
  const newPage = () => {
    pages.push(page)
    page = { columns: [[]] }
    used = 0
  }
  blocks.forEach((b, i) => {
    const h = heights[i] ?? 0
    const col = () => page.columns[page.columns.length - 1]
    if (b.breakBefore === 'page' && (col().length || page.columns.length > 1)) newPage()
    else if (b.breakBefore === 'column' && columnBreaks && col().length) newColumn()
    const withNext = b.keepWithNext ? h + (heights[i + 1] ?? 0) : h
    if (used > 0 && used + withNext > colHeight) newColumn()
    col().push(b)
    used += h
  })
  if (page.columns.some((c) => c.length)) pages.push(page)
  return pages.length ? pages : [{ columns: [[]] }]
}
