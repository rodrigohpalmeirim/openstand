import { Check } from 'lucide-react'
import { Fragment, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { useSettings, type Settings } from '../state/settings'
import { ACTIONS, type ActionId } from '../viewer/actions'
import { cx, Popover, Segmented, Select, Slider, Toggle } from '../ui/primitives'

/* ------------------------------------------------------------ Path access */

/** Read a dotted settings path, e.g. "display.nightMode". */
export function getPath(s: Settings, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], s)
}

/** Write a dotted settings path through the store (set / setIn), copying each level immutably. */
export function setPath(path: string, value: unknown) {
  const st = useSettings.getState()
  const [top, ...rest] = path.split('.')
  if (!rest.length) return st.set({ [top]: value } as Partial<Settings>)
  if (rest.length === 1) return st.setIn(top as keyof Settings, { [rest[0]]: value } as never)
  const put = (o: Record<string, unknown>, keys: string[]): Record<string, unknown> =>
    keys.length === 1 ? { ...o, [keys[0]]: value } : { ...o, [keys[0]]: put((o[keys[0]] ?? {}) as Record<string, unknown>, keys.slice(1)) }
  st.setIn(top as keyof Settings, { [rest[0]]: put(getPath(st.s, `${top}.${rest[0]}`) as Record<string, unknown>, rest.slice(1)) } as never)
}

export function useSetting<T>(path: string): [T, (v: T) => void] {
  const v = useSettings((st) => getPath(st.s, path)) as T
  return [v, (nv: T) => setPath(path, nv)]
}

/* ---------------------------------------------------------- Registry types */

export interface SettingItem {
  id: string
  label: string
  /** Extra words for search (synonyms, the hint text…). */
  keywords?: string
  Comp: ComponentType
}

export interface SettingGroup {
  title?: string
  description?: ReactNode
  items: SettingItem[]
}

/* ------------------------------------------------------------------ Layout */

export function Group({ title, description, children }: { title?: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      {(title || description) && (
        <div className="px-1">
          {title && <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>}
          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
        </div>
      )}
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">{children}</div>
    </section>
  )
}

/** One settings row: label + hint on the left, control on the right (or below when `stacked`). */
export function Row({
  label,
  hint,
  children,
  stacked,
  htmlFor,
}: {
  label: ReactNode
  hint?: ReactNode
  children?: ReactNode
  stacked?: boolean
  htmlFor?: string
}) {
  const text = (
    <div className={cx('flex-1', stacked ? 'min-w-0' : 'min-w-36')}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-fg">
        {label}
      </label>
      {hint && <div className="mt-0.5 text-xs leading-snug text-muted">{hint}</div>}
    </div>
  )
  if (stacked)
    return (
      <div className="flex flex-col gap-3 px-4 py-3.5">
        {text}
        {children}
      </div>
    )
  return (
    <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
      {text}
      <div className="ml-auto flex max-w-full shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

/* ------------------------------------------------------------ Item makers */

let uidCounter = 0
const useId = () => useState(() => `set-${++uidCounter}`)[0]

export function toggleItem(path: string, label: string, hint?: string, keywords?: string): SettingItem {
  return {
    id: path,
    label,
    keywords: [hint, keywords].filter(Boolean).join(' '),
    Comp: function ToggleItem() {
      const [v, set] = useSetting<boolean>(path)
      return (
        <Row label={label} hint={hint}>
          <Toggle checked={!!v} onChange={set} label={label} />
        </Row>
      )
    },
  }
}

export interface Opt<T> {
  value: T
  label: ReactNode
  title?: string
}

export function segItem<T extends string | number>(path: string, label: string, options: Opt<T>[], hint?: string, keywords?: string): SettingItem {
  return {
    id: path,
    label,
    keywords: [hint, keywords, ...options.map((o) => (typeof o.label === 'string' ? o.label : ''))].filter(Boolean).join(' '),
    Comp: function SegItem() {
      const [v, set] = useSetting<T>(path)
      const wide = options.length > 3
      return (
        <Row label={label} hint={hint} stacked={wide}>
          <Segmented label={label} value={v} options={options} onChange={set} className={wide ? 'w-full overflow-x-auto' : undefined} />
        </Row>
      )
    },
  }
}

export function selectItem<T extends string | number>(path: string, label: string, options: Opt<T>[], hint?: string, keywords?: string): SettingItem {
  return {
    id: path,
    label,
    keywords: [hint, keywords, ...options.map((o) => (typeof o.label === 'string' ? o.label : ''))].filter(Boolean).join(' '),
    Comp: function SelectItem() {
      const [v, set] = useSetting<T>(path)
      const id = useId()
      return (
        <Row label={label} hint={hint} htmlFor={id}>
          <Select
            id={id}
            value={String(v)}
            className="w-auto min-w-36"
            onChange={(e) => {
              const o = options.find((x) => String(x.value) === e.target.value)
              if (o) set(o.value)
            }}
          >
            {options.map((o) => (
              <option key={String(o.value)} value={String(o.value)}>
                {String(o.label)}
              </option>
            ))}
          </Select>
        </Row>
      )
    },
  }
}

export function sliderItem(
  path: string,
  label: string,
  o: { min: number; max: number; step?: number; format?: (v: number) => string },
  hint?: string,
  keywords?: string,
): SettingItem {
  return {
    id: path,
    label,
    keywords: [hint, keywords].filter(Boolean).join(' '),
    Comp: function SliderItem() {
      const [v, set] = useSetting<number>(path)
      return (
        <Row
          stacked
          label={
            <span className="flex items-baseline justify-between gap-3">
              <span>{label}</span>
              <span className="font-mono text-xs tabular-nums text-muted">{o.format ? o.format(v) : v}</span>
            </span>
          }
          hint={hint}
        >
          <Slider value={v} min={o.min} max={o.max} step={o.step} onChange={set} label={label} />
        </Row>
      )
    },
  }
}

/** `enabledBy`: path of a boolean setting; the picker is disabled while it is off. */
export function actionItem(path: string, label: string, hint?: string, keywords?: string, enabledBy?: string): SettingItem {
  return {
    id: path,
    label,
    keywords: [hint, keywords, 'action gesture'].filter(Boolean).join(' '),
    Comp: function ActionItem() {
      const [v, set] = useSetting<ActionId>(path)
      const on = useSettings((st) => (enabledBy ? !!getPath(st.s, enabledBy) : true))
      const id = useId()
      return (
        <Row label={label} hint={hint} htmlFor={id}>
          <ActionSelect id={id} value={v} onChange={set} disabled={!on} />
        </Row>
      )
    },
  }
}

export function colorItem(path: string, label: string, hint?: string): SettingItem {
  return {
    id: path,
    label,
    keywords: [hint, 'colour color'].filter(Boolean).join(' '),
    Comp: function ColorItem() {
      const [v, set] = useSetting<string>(path)
      const id = useId()
      // Native color inputs fire on every drag step; that is fine for a local store write.
      return (
        <Row label={label} hint={hint} htmlFor={id}>
          <span className="font-mono text-xs uppercase text-muted">{v}</span>
          <input
            id={id}
            type="color"
            value={v}
            onChange={(e) => set(e.target.value)}
            className="h-9 w-12 cursor-pointer rounded-md border border-line bg-surface p-0.5"
          />
        </Row>
      )
    },
  }
}

export function customItem(id: string, label: string, Comp: ComponentType, keywords?: string): SettingItem {
  return { id, label, keywords, Comp }
}

/* --------------------------------------------------------- Action pickers */

/** ACTIONS grouped by their catalogue group, in catalogue order. */
export function actionGroups(): { group: string; actions: ActionId[] }[] {
  const out: { group: string; actions: ActionId[] }[] = []
  for (const id of Object.keys(ACTIONS) as ActionId[]) {
    const g = ACTIONS[id].group
    let e = out.find((x) => x.group === g)
    if (!e) out.push((e = { group: g, actions: [] }))
    e.actions.push(id)
  }
  return out
}

export function ActionSelect({
  value,
  onChange,
  id,
  className,
  label,
  disabled,
}: {
  value: ActionId
  onChange: (a: ActionId) => void
  id?: string
  className?: string
  label?: string
  disabled?: boolean
}) {
  return (
    <Select id={id} aria-label={label} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value as ActionId)} className={cx('w-auto min-w-44 max-w-full disabled:opacity-50', className)}>
      {actionGroups().map((g) => (
        <optgroup key={g.group} label={g.group}>
          {g.actions.map((a) => (
            <option key={a} value={a}>
              {ACTIONS[a].label}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  )
}

/** Grouped action list in a popover (used by the touch zone editor). */
export function ActionMenu({
  anchor,
  open,
  onClose,
  value,
  onChange,
  title,
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  value: ActionId
  onChange: (a: ActionId) => void
  title?: string
}) {
  useEffect(() => {
    if (open) requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-action-current="true"]')?.focus())
  }, [open])
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="center" className="w-64">
      {title && <div className="px-3 pb-1 pt-2 text-xs font-semibold text-fg">{title}</div>}
      <div
        role="listbox"
        aria-label={title ?? 'Action'}
        onKeyDown={(e) => {
          const list = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')]
          const at = list.indexOf(document.activeElement as HTMLElement)
          const k = e.key
          const next = k === 'ArrowDown' ? Math.min(list.length - 1, at + 1) : k === 'ArrowUp' ? Math.max(0, at - 1) : k === 'Home' ? 0 : k === 'End' ? list.length - 1 : -1
          if (next < 0) return
          e.preventDefault()
          e.stopPropagation()
          list[next].focus()
        }}
      >
        {actionGroups().map((g) => (
          <Fragment key={g.group}>
            <div className="px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-faint">{g.group}</div>
            {g.actions.map((a) => (
              <button
                key={a}
                role="option"
                aria-selected={a === value}
                data-action-current={a === value}
                onClick={() => {
                  onChange(a)
                  onClose()
                  anchor?.focus({ preventScroll: true })
                }}
                className={cx(
                  'flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm transition hover:bg-surface-2',
                  a === value && 'font-semibold text-accent',
                )}
              >
                <span className="flex-1">{ACTIONS[a].label}</span>
                {a === value && <Check className="size-4" />}
              </button>
            ))}
          </Fragment>
        ))}
      </div>
    </Popover>
  )
}

/** Matches when every word of the query appears in the haystack. */
export function matches(query: string, ...hay: (string | undefined)[]): boolean {
  const h = hay.filter(Boolean).join(' ').toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => h.includes(w))
}
