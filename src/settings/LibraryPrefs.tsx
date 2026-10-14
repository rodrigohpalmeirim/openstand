import { ArrowDown, ArrowUp } from 'lucide-react'
import { GROUP_FIELDS, type GroupField } from '../db/schema'
import { terms, useTerms } from '../library/browse/terms'
import type { Section } from '../state/nav'
import { useSettings } from '../state/settings'
import { cx, IconButton, Input, Toggle } from '../ui/primitives'
import { Row } from './kit'

/**
 * Library sections that can be shown/hidden in the sidebar. Songs, Recent, Favorites and Bookmarks
 * are always there, so they aren't offered (their toggles did nothing).
 */
const GROUP_SECTIONS: Section[] = ['setlists', ...GROUP_FIELDS]

/** Extra per-song columns available in list view. */
const LIST_FIELDS = [...GROUP_FIELDS, 'rating', 'difficulty', 'duration'] as const
const EXTRA_LABEL: Record<string, string> = { rating: 'Rating', difficulty: 'Difficulty', duration: 'Duration' }

/** Chips to choose which details show under each song in list view (order = tap order). */
export function ListFieldsEditor() {
  const fields = useSettings((st) => st.s.listFields)
  const set = useSettings((st) => st.set)
  const t = useTerms()
  const label = (f: string) => EXTRA_LABEL[f] ?? t.one(f as GroupField)
  return (
    <Row stacked label="Details shown in the list" hint="Shown under each title, in the order you pick them.">
      <div className="flex flex-wrap gap-2">
        {LIST_FIELDS.map((f) => {
          const i = fields.indexOf(f)
          const on = i >= 0
          return (
            <button
              key={f}
              aria-pressed={on}
              onClick={() => set({ listFields: on ? fields.filter((x) => x !== f) : [...fields, f] })}
              className={cx(
                'inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm transition',
                on ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg',
              )}
            >
              {on && <span className="font-mono text-[11px] tabular-nums">{i + 1}</span>}
              {label(f)}
            </button>
          )
        })}
      </div>
    </Row>
  )
}

/** Rename library fields (e.g. "Custom" → "Arranger"). Empty = default name. */
export function FieldLabelsEditor() {
  const labels = useSettings((st) => st.s.fieldLabels)
  const set = useSettings((st) => st.set)
  const terminology = useSettings((st) => st.s.terminology)
  return (
    <Row stacked label="Field names" hint="Rename any field. Leave empty to use the default name.">
      <div className="grid gap-2 sm:grid-cols-2">
        {GROUP_FIELDS.map((f) => (
          <label key={f} className="flex items-center gap-2">
            <span className="w-28 shrink-0 truncate text-xs text-muted">{defaultGroupLabel(f, terminology)}</span>
            <Input
              value={labels[f] ?? ''}
              placeholder={defaultGroupLabel(f, terminology)}
              onChange={(e) => {
                const next = { ...labels, [f]: e.target.value }
                if (!e.target.value) delete next[f]
                set({ fieldLabels: next })
              }}
            />
          </label>
        ))}
      </div>
    </Row>
  )
}

/** Built-in name of a field (terms() without custom labels). */
const defaultGroupLabel = (f: GroupField, terminology: 'song' | 'piece') => terms({ terminology, fieldLabels: {} }).group(f)

/** Choose and order the library sections. Hidden sections keep their relative order at the end. */
export function GroupsEditor() {
  const visible = useSettings((st) => st.s.visibleGroups)
  const set = useSettings((st) => st.set)
  const t = useTerms()
  const hidden = GROUP_SECTIONS.filter((g) => !visible.includes(g))
  const move = (i: number, d: number) => {
    const next = [...visible]
    const j = i + d
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    set({ visibleGroups: next })
  }
  const row = (g: string, i: number, on: boolean) => (
    <li key={g} className="flex min-h-12 items-center gap-2 px-1">
      <Toggle
        checked={on}
        label={`Show ${t.section(g as Section)}`}
        onChange={(v) => set({ visibleGroups: v ? [...visible, g] : visible.filter((x) => x !== g) })}
      />
      <span className={cx('flex-1 text-sm', !on && 'text-muted')}>{t.section(g as Section)}</span>
      {on && (
        <>
          <IconButton size="sm" label={`Move ${t.section(g as Section)} up`} disabled={i === 0} onClick={() => move(i, -1)}>
            <ArrowUp className="size-4" />
          </IconButton>
          <IconButton size="sm" label={`Move ${t.section(g as Section)} down`} disabled={i === visible.length - 1} onClick={() => move(i, 1)}>
            <ArrowDown className="size-4" />
          </IconButton>
        </>
      )}
    </li>
  )
  return (
    <Row stacked label="Library sections" hint={`${t.Songs}, Recent, Favorites and Bookmarks are always shown. Turn the other sections on or off and set their order.`}>
      <ul className="-my-1 divide-y divide-line">
        {visible.filter((g) => GROUP_SECTIONS.includes(g as Section)).map((g) => row(g, visible.indexOf(g), true))}
        {hidden.map((g) => row(g, -1, false))}
      </ul>
    </Row>
  )
}

export function ArticlesInput() {
  const articles = useSettings((st) => st.s.articles)
  const ignore = useSettings((st) => st.s.ignoreArticles)
  const set = useSettings((st) => st.set)
  return (
    <Row label="Articles to ignore" hint="Comma-separated, e.g. “The, A, An, Le, La, Die”.">
      <Input className="w-48" value={articles ?? ''} disabled={!ignore} onChange={(e) => set({ articles: e.target.value })} />
    </Row>
  )
}
