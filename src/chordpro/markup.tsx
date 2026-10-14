/**
 * Pango-like inline markup used by ChordPro (<b>, <i>, <span color="red">…). Markup is parsed into
 * styled runs and rendered as React elements with validated inline styles — user text is never
 * injected as HTML. Unknown tags are kept as literal text.
 */
import type { CSSProperties } from 'react'

export interface MarkupStyle {
  bold?: boolean
  weight?: number
  italic?: boolean
  underline?: boolean
  strike?: boolean
  overline?: boolean
  mono?: boolean
  family?: string
  /** CSS font-size value (relative units only, so zoom keeps working). */
  size?: string
  color?: string
  background?: string
  valign?: 'super' | 'sub'
  transform?: 'uppercase' | 'lowercase' | 'capitalize'
}

export interface Run {
  text: string
  style: MarkupStyle
}

export type TagStack = { name: string; style: MarkupStyle }[]

const TAGS = new Set(['b', 'i', 'u', 's', 'tt', 'big', 'small', 'sub', 'sup', 'emp', 'span', 'img'])
const TAG_RE = /<(\/?)([a-z]+)((?:\s+[a-z_]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))*)\s*(\/?)>/gi
const ATTR_RE = /([a-z_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi

export function hasMarkup(text: string): boolean {
  TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(text))) if (TAGS.has(m[2].toLowerCase())) return true
  return /&(lt|gt|amp|quot|apos|#\d+);/.test(text)
}

const decode = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+);/g, (_, e: string) =>
    e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'amp' ? '&' : e === 'quot' ? '"' : e === 'apos' ? "'" : String.fromCodePoint(Number(e.slice(1))),
  )

export function safeColor(v: string | undefined): string | undefined {
  if (!v) return undefined
  const t = v.trim()
  return /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t) || /^[a-z]{3,24}$/i.test(t) ? t : undefined
}

const SIZE_WORDS: Record<string, string> = {
  'xx-small': '0.58em', 'x-small': '0.69em', small: '0.83em', medium: '1em', large: '1.2em', 'x-large': '1.44em', 'xx-large': '1.73em',
  larger: '1.2em', smaller: '0.83em',
}

/** Convert a Pango/ChordPro size to a relative CSS size (the lyrics base is treated as 12pt). */
export function safeSize(v: string | undefined, base = 12): string | undefined {
  if (!v) return undefined
  const t = v.trim().toLowerCase()
  if (SIZE_WORDS[t]) return SIZE_WORDS[t]
  const m = /^(\d+(?:\.\d+)?)(pt|px|%)?$/.exec(t)
  if (!m) return undefined
  let n = Number(m[1])
  if (m[2] === '%') return `${Math.min(400, n) / 100}em`
  if (!m[2] && n > 400) n /= 1024 // Pango sizes are in 1024ths of a point
  return `${Math.max(0.3, Math.min(4, n / base)).toFixed(3)}em`
}

function safeFamily(v: string | undefined): string | undefined {
  if (!v) return undefined
  const t = v.trim().toLowerCase()
  if (/^(sans|sans-serif|sans serif|helvetica|arial|roboto)\b/.test(t)) return 'var(--font-sans)'
  if (/^(serif|times|georgia|noto serif)\b/.test(t)) return 'var(--font-serif)'
  if (/^(mono|monospace|courier)\b/.test(t)) return 'var(--font-mono)'
  return /^[\w\s-]{1,40}$/.test(v.trim()) ? `"${v.trim()}", var(--font-sans)` : undefined
}

function spanStyle(attrs: string): MarkupStyle {
  const st: MarkupStyle = {}
  ATTR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ATTR_RE.exec(attrs))) {
    const key = m[1].toLowerCase()
    const val = decode(m[2] ?? m[3] ?? m[4] ?? '')
    switch (key) {
      case 'color':
      case 'foreground':
      case 'fgcolor':
        st.color = safeColor(val)
        break
      case 'background':
      case 'bgcolor':
        st.background = safeColor(val)
        break
      case 'size':
      case 'font_size':
        st.size = safeSize(val)
        break
      case 'font_scale':
        if (Number(val) > 0) st.size = `${Math.min(4, Number(val))}em`
        break
      case 'weight':
      case 'font_weight':
        if (/^(bold|heavy|ultrabold|black|semibold)$/i.test(val)) st.bold = true
        else if (/^\d{3}$/.test(val)) st.weight = Number(val)
        else if (/^(light|ultralight|thin|book)$/i.test(val)) st.weight = 300
        else if (/^normal$/i.test(val)) st.bold = false
        break
      case 'style':
      case 'font_style':
        st.italic = /^(italic|oblique)$/i.test(val)
        break
      case 'underline':
        st.underline = !/^(none|false)$/i.test(val)
        break
      case 'strikethrough':
        st.strike = /^(true|1)$/i.test(val)
        break
      case 'overline':
        st.overline = !/^(none|false)$/i.test(val)
        break
      case 'face':
      case 'font':
      case 'font_desc':
      case 'font_family':
        st.family = safeFamily(val.replace(/\s+\d+(\.\d+)?$/, ''))
        break
      case 'text_transform':
        if (/^(uppercase|lowercase|capitalize)$/.test(val)) st.transform = val as MarkupStyle['transform']
        break
    }
  }
  return st
}

function tagStyle(name: string, attrs: string): MarkupStyle {
  switch (name) {
    case 'b':
      return { bold: true }
    case 'i':
    case 'emp':
      return { italic: true }
    case 'u':
      return { underline: true }
    case 's':
      return { strike: true }
    case 'tt':
      return { mono: true }
    case 'big':
      return { size: '1.2em' }
    case 'small':
      return { size: '0.83em' }
    case 'sup':
      return { valign: 'super', size: '0.75em' }
    case 'sub':
      return { valign: 'sub', size: '0.75em' }
    default:
      return spanStyle(attrs)
  }
}

const merged = (stack: TagStack): MarkupStyle => Object.assign({}, ...stack.map((t) => t.style))

/** Parse markup into runs. `stack` carries tags left open by a previous chunk of the same line. */
export function parseMarkup(text: string, stack: TagStack = []): { runs: Run[]; stack: TagStack } {
  const st = [...stack]
  const runs: Run[] = []
  let last = 0
  const pushText = (t: string) => {
    if (t) runs.push({ text: decode(t), style: merged(st) })
  }
  TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(text))) {
    const name = m[2].toLowerCase()
    if (!TAGS.has(name)) continue
    pushText(text.slice(last, m.index))
    last = m.index + m[0].length
    if (name === 'img') continue
    if (m[1]) {
      const i = st.map((t) => t.name).lastIndexOf(name)
      if (i >= 0) st.splice(i, 1)
    } else if (!m[4]) st.push({ name, style: tagStyle(name, m[3]) })
  }
  pushText(text.slice(last))
  return { runs, stack: st }
}

export function stripMarkup(text: string): string {
  return parseMarkup(text).runs.map((r) => r.text).join('')
}

export function runCss(s: MarkupStyle): CSSProperties {
  const deco = [s.underline && 'underline', s.strike && 'line-through', s.overline && 'overline'].filter(Boolean).join(' ')
  return {
    fontWeight: s.bold ? 700 : s.weight,
    fontStyle: s.italic ? 'italic' : undefined,
    textDecoration: deco || undefined,
    fontFamily: s.mono ? 'var(--font-mono)' : s.family,
    fontSize: s.size,
    color: s.color,
    background: s.background,
    verticalAlign: s.valign,
    textTransform: s.transform,
  }
}

const isPlain = (s: MarkupStyle) => Object.values(s).every((v) => v === undefined)

/** Render runs as React elements. */
export function Runs({ runs }: { runs: Run[] }) {
  return (
    <>
      {runs.map((r, i) =>
        isPlain(r.style) ? (
          <span key={i}>{r.text}</span>
        ) : (
          <span key={i} style={runCss(r.style)}>
            {r.text}
          </span>
        ),
      )}
    </>
  )
}

/** Convenience: render a markup string. */
export function MarkupText({ text }: { text: string }) {
  if (!hasMarkup(text)) return <>{text}</>
  return <Runs runs={parseMarkup(text).runs} />
}
