import { ArrowLeft, ChevronRight, Download, MoreVertical, RotateCcw, Search, Upload, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNav } from '../state/nav'
import { useSettings } from '../state/settings'
import { Button, confirmDialog, cx, Empty, IconButton, Menu, toast, useMenu } from '../ui/primitives'
import { downloadText, pickFile, resetAllSettings, settingsFromJSON, settingsToJSON } from './io'
import { Group, matches, type SettingItem } from './kit'
import { useSections, type SectionDef } from './sections'

function useMediaQuery(q: string) {
  const [m, setM] = useState(() => window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const on = () => setM(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [q])
  return m
}

function search(sections: SectionDef[], query: string): { section: SectionDef; items: SettingItem[] }[] {
  if (!query.trim()) return []
  return sections.map((section) => {
    // Searching for a section name shows the whole section.
    const all = section.groups.flatMap((g) => g.items)
    const items = matches(query, section.title) ? all : all.filter((it) => matches(query, it.label, it.keywords))
    return { section, items }
  }).filter((r) => r.items.length > 0)
}

function SearchBox({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement))) {
        e.preventDefault()
        ref.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="relative w-full">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
      <input
        ref={ref}
        type="search"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && value && (e.stopPropagation(), onChange(''))}
        placeholder="Search settings"
        aria-label="Search settings"
        style={{ outline: 'none' }} // focus is shown by the ring; the global outline would double it
        className="h-10 w-full rounded-lg border border-line bg-surface pl-9 pr-9 text-sm text-fg outline-none transition placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent-soft [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button aria-label="Clear search" onClick={() => onChange('')} className="absolute right-1 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted hover:text-fg">
          <X className="size-4" />
        </button>
      )}
    </div>
  )
}

function SectionList({ current, onOpen }: { current?: string; onOpen: (id: string) => void }) {
  const sections = useSections()
  return (
    <nav aria-label="Settings sections">
      <ul className="flex flex-col gap-0.5">
        {sections.map((s) => {
          const Icon = s.icon
          const active = s.id === current
          return (
            <li key={s.id}>
              <button
                onClick={() => onOpen(s.id)}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition',
                  active ? 'bg-accent-soft text-accent' : 'text-fg hover:bg-surface-2',
                )}
              >
                <Icon className={cx('size-5 shrink-0', active ? 'text-accent' : 'text-muted')} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{s.title}</span>
                  <span className={cx('block truncate text-xs', active ? 'text-accent/80' : 'text-muted')}>{s.summary}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-faint md:hidden" />
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

function SectionContent({ section, showTitle }: { section: SectionDef; showTitle: boolean }) {
  return (
    <div className="flex flex-col gap-6">
      {showTitle && (
        <div>
          <h2 data-section-heading tabIndex={-1} className="text-xl font-semibold outline-none">
            {section.title}
          </h2>
          <p className="mt-0.5 text-sm text-muted">{section.summary}</p>
        </div>
      )}
      {section.groups.map((g, i) => (
        <Group key={i} title={g.title} description={g.description}>
          {g.items.map((it) => (
            <it.Comp key={it.id} />
          ))}
        </Group>
      ))}
      {section.reset && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            icon={<RotateCcw className="size-4" />}
            onClick={async () => {
              if (!(await confirmDialog({ title: `Reset ${section.title}?`, message: `All ${section.title.toLowerCase()} settings go back to their defaults.`, confirmLabel: 'Reset' })))
                return
              section.reset!()
              toast(`${section.title} reset to defaults`, 'ok')
            }}
          >
            Reset to defaults
          </Button>
        </div>
      )}
    </div>
  )
}

function SearchResults({ query, onOpen }: { query: string; onOpen: (id: string) => void }) {
  const sections = useSections()
  const results = useMemo(() => search(sections, query), [sections, query])
  if (!results.length)
    return (
      <Empty icon={<Search className="size-6" />} title="No matching settings">
        Try another word, like “night”, “pedal” or “chords”.
      </Empty>
    )
  return (
    <div className="flex flex-col gap-6">
      {results.map(({ section, items }) => (
        <section key={section.id} className="flex flex-col gap-2">
          <button onClick={() => onOpen(section.id)} className="flex items-center gap-1 self-start px-1 text-xs font-semibold uppercase tracking-wide text-muted hover:text-accent">
            {section.title}
            <ChevronRight className="size-3.5" />
          </button>
          <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {items.map((it) => (
              <it.Comp key={it.id} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function MoreMenu() {
  const m = useMenu()
  const replace = useSettings((s) => s.replace)
  return (
    <>
      <IconButton ref={m.ref} label="More options" onClick={m.toggle}>
        <MoreVertical className="size-5" />
      </IconButton>
      <Menu
        anchor={m.anchor}
        open={m.open}
        onClose={m.close}
        items={[
          {
            label: 'Export settings…',
            icon: <Download className="size-4" />,
            onSelect: () => {
              downloadText(`openstand-settings-${new Date().toISOString().slice(0, 10)}.json`, settingsToJSON(useSettings.getState().s))
              toast('Settings exported', 'ok')
            },
          },
          {
            label: 'Import settings…',
            icon: <Upload className="size-4" />,
            onSelect: async () => {
              const file = await pickFile('.json,application/json')
              if (!file) return
              try {
                const next = settingsFromJSON(await file.text(), useSettings.getState().s)
                if (!(await confirmDialog({ title: 'Replace your settings?', message: `Settings from “${file.name}” replace the current ones on this device.`, confirmLabel: 'Import' })))
                  return
                replace(next)
                toast('Settings imported', 'ok')
              } catch (e) {
                toast((e as Error).message, 'error')
              }
            },
          },
          { divider: true, label: '' },
          {
            label: 'Reset all settings…',
            icon: <RotateCcw className="size-4" />,
            danger: true,
            onSelect: async () => {
              const message =
                'Every setting goes back to its default, including key, pedal, MIDI and face-gesture bindings and tap zones. ' +
                'Your library, annotation favourites and recent colours, import patterns, and this device’s name, sync room and MIDI ports are kept.'
              if (!(await confirmDialog({ title: 'Reset all settings?', message, confirmLabel: 'Reset all', danger: true }))) return
              replace(resetAllSettings(useSettings.getState().s))
              toast('All settings reset', 'ok')
            },
          },
        ]}
      />
    </>
  )
}

/** Settings screen: two panes on wide screens, list → detail on phones, with search across sections. */
export function SettingsScreen() {
  const route = useNav((n) => n.route)
  const go = useNav((n) => n.go)
  const wide = useMediaQuery('(min-width: 768px)')
  const [query, setQuery] = useState('')
  const page = route.name === 'settings' ? route.page : undefined
  const sections = useSections()
  const selected = sections.find((s) => s.id === page)
  const current = selected ?? (wide ? sections[0] : undefined)
  const searching = query.trim().length > 0
  const mainRef = useRef<HTMLDivElement>(null)
  const focusHeading = useRef(false)

  const toLibrary = () => go(useNav.getState().lastLibrary)
  const open = (id?: string) => {
    setQuery('')
    focusHeading.current = !!id
    go({ name: 'settings', page: id })
  }
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
    // A section opened from the list (or search): move focus to its heading, so keyboard and screen
    // reader users land in the content rather than back at the top of the list.
    if (focusHeading.current && current?.id) document.querySelector<HTMLElement>('[data-section-heading]')?.focus({ preventScroll: true })
    focusHeading.current = false
  }, [current?.id, searching])

  if (wide) {
    return (
      <div className="flex h-full flex-col bg-bg text-fg">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
          <IconButton label="Back to library" onClick={toLibrary}>
            <ArrowLeft className="size-5" />
          </IconButton>
          <h1 className="w-60 text-base font-semibold">Settings</h1>
          <div className="mx-auto w-full max-w-md">
            <SearchBox value={query} onChange={setQuery} />
          </div>
          <MoreMenu />
        </header>
        <div className="flex min-h-0 flex-1">
          <aside className="w-72 shrink-0 overflow-y-auto border-r border-line p-3">
            <SectionList current={searching ? undefined : current?.id} onOpen={open} />
          </aside>
          <main ref={mainRef} className="min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-2xl px-6 py-8">
              {searching ? <SearchResults query={query} onOpen={open} /> : current && <SectionContent key={current.id} section={current} showTitle />}
            </div>
          </main>
        </div>
      </div>
    )
  }

  // Phone: section list (with search) or one section with a back button.
  const inSection = !!selected && !searching
  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-2">
        <IconButton label={inSection ? 'Back to settings' : 'Back to library'} onClick={() => (inSection ? open(undefined) : toLibrary())}>
          <ArrowLeft className="size-5" />
        </IconButton>
        <h1 data-section-heading={inSection || undefined} tabIndex={inSection ? -1 : undefined} className="min-w-0 flex-1 truncate text-base font-semibold outline-none">
          {inSection ? selected!.title : 'Settings'}
        </h1>
        {!inSection && <MoreMenu />}
      </header>
      <main ref={mainRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 px-3 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {inSection ? (
            <SectionContent key={selected!.id} section={selected!} showTitle={false} />
          ) : (
            <>
              <SearchBox value={query} onChange={setQuery} />
              {searching ? <SearchResults query={query} onOpen={open} /> : <SectionList onOpen={open} />}
            </>
          )}
        </div>
      </main>
    </div>
  )
}
