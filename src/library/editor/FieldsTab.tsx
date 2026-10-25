import { Grid3x3, SlidersHorizontal, Star } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { GroupField, Song } from '../../db/schema'
import { capitalizeWords, formatDuration, isDurationText, parseDuration } from '../../files/import'
import { ALL_KEYS, KEYS } from '../../music/chords'
import { useSettings } from '../../state/settings'
import { cx, Field, IconButton, Input, Popover, Select, Toggle, useMenu } from '../../ui/primitives'
import { useTerms } from '../browse/terms'
import { ChipInput } from './ChipInput'

export type SongPatch = Partial<Song> | ((s: Song) => Song)

/** Field keys that can be hidden via "Configure fields" (title is always shown). "Song" follows the terminology setting. */
export const CONFIGURABLE_FIELDS: { key: string; label: string }[] = [
  { key: 'sortTitle', label: 'Sort title' },
  { key: 'songNumber', label: 'Song number' },
  { key: 'artists', label: 'Artists' },
  { key: 'composers', label: 'Composers' },
  { key: 'albums', label: 'Albums / books' },
  { key: 'genres', label: 'Genres' },
  { key: 'collections', label: 'Collections' },
  { key: 'keys', label: 'Key' },
  { key: 'signatures', label: 'Time signature' },
  { key: 'tempos', label: 'Tempo (BPM)' },
  { key: 'duration', label: 'Duration' },
  { key: 'rating', label: 'Rating' },
  { key: 'difficulty', label: 'Difficulty' },
  { key: 'sources', label: 'Source types' },
  { key: 'years', label: 'Years' },
  { key: 'tags', label: 'Tags' },
  { key: 'keywords', label: 'Keywords' },
  { key: 'custom', label: 'Custom' },
  { key: 'custom2', label: 'Custom 2' },
]

const SIGNATURES = ['4/4', '3/4', '2/4', '2/2', '6/8', '9/8', '12/8', '5/4', '7/8', '3/8', '6/4', '7/4']
const SOURCE_TYPES = ['Sheet Music', 'Lead Sheet', 'Chords', 'Lyrics', 'Tab', 'Charts']
const GENRES = ['Blues', 'Bluegrass', 'Celtic', 'Choral', 'Christmas', 'Classical', 'Country', 'Film', 'Folk', 'Funk', 'Gospel', 'Hymn', 'Jazz', 'Latin', 'Metal', 'Musical', 'Pop', 'R&B', 'Reggae', 'Rock', 'Soul', 'Worship']
const MINORS = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm']

export function FieldsTab({
  song,
  update,
  titleError,
  titleRef,
  durationText: durText,
  onDurationText,
}: {
  song: Song
  update: (p: SongPatch) => void
  titleError?: string
  titleRef?: React.Ref<HTMLInputElement>
  /** Duration as typed while it differs from the stored value (lifted so the editor can refuse to save invalid text). */
  durationText?: string | null
  onDurationText?: (t: string | null) => void
}) {
  const [localDur, setLocalDur] = useState<string | null>(null)
  const hidden = useSettings((s) => s.s.editor.hiddenFields)
  const capitalize = useSettings((s) => s.s.editor.capitalizeWords)
  const labels = useSettings((s) => s.s.fieldLabels)
  const t = useTerms()
  const show = (k: string) => !hidden.includes(k)
  const label = (k: string) => labels[k] || CONFIGURABLE_FIELDS.find((f) => f.key === k)?.label.replace(/^Song\b/, t.Song) || k

  const group = (field: GroupField, extra: { suggestions?: string[]; placeholder?: string; trailing?: ReactNode; validate?: (v: string) => string | null; showAll?: boolean } = {}) =>
    show(field) && (
      <Field label={label(field)} key={field}>
        <ChipInput
          aria-label={label(field)}
          field={field}
          value={song[field]}
          onChange={(v) => update({ [field]: v })}
          // Tags are free-form labels ("needs work"): kept as typed, like keys, signatures and years.
          capitalize={capitalize && field !== 'keys' && field !== 'signatures' && field !== 'years' && field !== 'tags'}
          suggestions={extra.suggestions}
          placeholder={extra.placeholder}
          trailing={extra.trailing}
          validate={extra.validate}
          showAllOnFocus={extra.showAll}
        />
      </Field>
    )

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-4 sm:p-6">
      <div className="flex items-end gap-2">
        <Field label="Title" className="flex-1" hint={titleError ? <span className="text-danger">{titleError}</span> : undefined}>
          <Input
            ref={titleRef}
            value={song.title}
            autoCapitalize={capitalize ? 'words' : 'sentences'}
            placeholder={`${t.Song} title`}
            aria-invalid={!!titleError}
            className={cx('h-11 text-base font-medium', titleError && 'border-danger')}
            onChange={(e) => update({ title: e.target.value })}
            onBlur={(e) => {
              const v = e.target.value.trim()
              // Only title-case text typed entirely in lower case, so deliberate casing ("iPhone", "AC/DC") survives.
              update({ title: capitalize && v === v.toLowerCase() ? capitalizeWords(v) : v })
            }}
          />
        </Field>
        <ConfigureFields />
      </div>

      {(show('sortTitle') || show('songNumber')) && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_10rem]">
          {show('sortTitle') && (
            <Field label={label('sortTitle')} hint="Used for sorting instead of the title">
              <Input value={song.sortTitle ?? ''} placeholder={song.title.replace(/^(the|a|an)\s+/i, '') || 'Same as title'} onChange={(e) => update({ sortTitle: e.target.value || undefined })} />
            </Field>
          )}
          {show('songNumber') && (
            <Field label={label('songNumber')}>
              <Input
                inputMode="numeric"
                value={song.songNumber ?? ''}
                placeholder="—"
                onChange={(e) => {
                  const n = e.target.value.replace(/\D/g, '')
                  update({ songNumber: n ? Number(n) : undefined })
                }}
              />
            </Field>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
        {group('artists', { placeholder: 'Add artist' })}
        {group('composers', { placeholder: 'Add composer' })}
        {group('albums', { placeholder: 'Album or book' })}
        {group('genres', { suggestions: GENRES, placeholder: 'Add genre', showAll: true })}
        {group('collections', { placeholder: 'Add to collection', showAll: true })}
        {group('keys', { suggestions: ALL_KEYS, placeholder: 'e.g. G, Em', trailing: <KeyGrid value={song.keys} onChange={(keys) => update({ keys })} /> })}
        {group('signatures', { suggestions: SIGNATURES, placeholder: 'e.g. 4/4', showAll: true })}
        {show('tempos') && (
          <Field label={label('tempos')}>
            <ChipInput
              aria-label={label('tempos')}
              inputMode="numeric"
              value={(song.tempos ?? []).map(String)}
              onChange={(v) => update({ tempos: v.map(Number) })}
              placeholder="e.g. 120"
              validate={(v) => {
                const n = Math.round(Number(v))
                return n >= 10 && n <= 400 ? String(n) : null
              }}
            />
          </Field>
        )}
        {show('duration') && (
          <DurationField
            label={label('duration')}
            value={song.duration}
            onChange={(duration) => update({ duration })}
            text={onDurationText ? (durText ?? null) : localDur}
            setText={onDurationText ?? setLocalDur}
          />
        )}
        {show('rating') && (
          <Field label={label('rating')}>
            <Stars value={song.rating} onChange={(rating) => update({ rating })} />
          </Field>
        )}
        {show('difficulty') && (
          <Field label={label('difficulty')}>
            <Select value={song.difficulty} onChange={(e) => update({ difficulty: Number(e.target.value) })}>
              <option value={0}>Not set</option>
              {Array.from({ length: 15 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1}
                  {i === 0 ? ' (easiest)' : i === 14 ? ' (hardest)' : ''}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {group('sources', { suggestions: SOURCE_TYPES, placeholder: 'e.g. Lead Sheet', showAll: true })}
        {group('years', { placeholder: 'e.g. 1959' })}
        {group('tags', { placeholder: 'Add tag' })}
        {group('custom', { placeholder: 'Custom value' })}
        {group('custom2', { placeholder: 'Custom value' })}
      </div>

      {show('keywords') && (
        <Field label={label('keywords')} hint="Extra words matched by search">
          <Input value={song.keywords} onChange={(e) => update({ keywords: e.target.value })} />
        </Field>
      )}
    </div>
  )
}

function DurationField({
  label,
  value,
  onChange,
  text,
  setText,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  text: string | null
  setText: (t: string | null) => void
}) {
  const shown = text ?? formatDuration(value)
  const bad = text !== null && !isDurationText(text)
  return (
    <Field label={label} hint={bad ? <span className="text-danger">Use m:ss, e.g. 3:45</span> : undefined}>
      <Input
        id="se-duration"
        inputMode="numeric"
        placeholder="m:ss"
        value={shown}
        aria-invalid={bad}
        className={bad ? 'border-danger' : undefined}
        onChange={(e) => {
          const v = e.target.value.replace(/[^\d:]/g, '')
          setText(v)
          // Valid text is stored as it's typed, so saving (e.g. Ctrl+S) never misses it.
          if (isDurationText(v)) onChange(parseDuration(v))
        }}
        onBlur={() => {
          if (text !== null && !bad) setText(null)
        }}
      />
    </Field>
  )
}

export function Stars({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex h-10 items-center" role="radiogroup" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n > 1 ? 's' : ''}`}
          className="flex size-10 items-center justify-center rounded-lg hover:bg-surface-2"
          onClick={() => onChange(value === n ? 0 : n)}
        >
          <Star className={cx('size-5.5 transition', n <= value ? 'fill-warn text-warn' : 'text-faint')} />
        </button>
      ))}
      {value > 0 && (
        <button type="button" className="ml-1 text-xs text-muted hover:text-fg" onClick={() => onChange(0)}>
          Clear
        </button>
      )}
    </div>
  )
}

function KeyGrid({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const m = useMenu()
  const toggle = (k: string) => onChange(value.includes(k) ? value.filter((v) => v !== k) : [...value, k])
  return (
    <>
      <IconButton ref={m.ref} label="Pick key" size="sm" onClick={m.toggle} active={m.open}>
        <Grid3x3 className="size-4" />
      </IconButton>
      <Popover anchor={m.anchor} open={m.open} onClose={m.close} className="p-2">
        {[KEYS, MINORS].map((row, r) => (
          <div key={r} className="grid grid-cols-6 gap-1 sm:grid-cols-12 [&:not(:first-child)]:mt-2">
            {row.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={value.includes(k)}
                onClick={() => toggle(k)}
                className={cx('h-10 min-w-11 rounded-md px-1 text-sm font-medium transition', value.includes(k) ? 'bg-accent text-accent-fg' : 'bg-surface-2 hover:bg-surface-3')}
              >
                {k}
              </button>
            ))}
          </div>
        ))}
      </Popover>
    </>
  )
}

function ConfigureFields() {
  const m = useMenu()
  const t = useTerms()
  const ed = useSettings((s) => s.s.editor)
  const setIn = useSettings((s) => s.setIn)
  const setHidden = (key: string, visible: boolean) =>
    setIn('editor', { hiddenFields: visible ? ed.hiddenFields.filter((k) => k !== key) : [...ed.hiddenFields, key] })
  return (
    <>
      <IconButton ref={m.ref} label="Configure fields" onClick={m.toggle} active={m.open} className="mb-0.5 size-11">
        <SlidersHorizontal className="size-5" />
      </IconButton>
      <Popover anchor={m.anchor} open={m.open} onClose={m.close} className="w-72 p-2">
        <div className="px-2 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-muted">Visible fields</div>
        <div className="grid grid-cols-1">
          {CONFIGURABLE_FIELDS.map((f) => (
            <label key={f.key} className="flex h-10 cursor-pointer items-center gap-3 rounded-lg px-2 text-sm hover:bg-surface-2">
              <input type="checkbox" className="size-4 accent-[var(--os-accent)]" checked={!ed.hiddenFields.includes(f.key)} onChange={(e) => setHidden(f.key, e.target.checked)} />
              {f.label.replace(/^Song\b/, t.Song)}
            </label>
          ))}
        </div>
        <div className="my-2 h-px bg-line" />
        <div className="flex items-center gap-3 px-2 py-1.5 text-sm">
          <span className="flex-1">
            Capitalize each word
            <span className="block text-xs text-muted">For lower-case titles and names</span>
          </span>
          <Toggle checked={ed.capitalizeWords} onChange={(v) => setIn('editor', { capitalizeWords: v })} label="Capitalize each word" />
        </div>
      </Popover>
    </>
  )
}
