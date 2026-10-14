import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import {
  capitalizeWords,
  folderFields,
  formatDuration,
  importFiles,
  matchPattern,
  parseDuration,
  previewSource,
  stripCommonRoot,
} from './import'

describe('import patterns', () => {
  it('matches filename patterns', () => {
    expect(matchPattern('%artist% - %title%', 'Miles Davis - So What')).toEqual({ artist: 'Miles Davis', title: 'So What' })
    expect(matchPattern('%title% (%key%)', 'Autumn Leaves (Gm)')).toEqual({ title: 'Autumn Leaves', key: 'Gm' })
    expect(matchPattern('%artist% - %title%', 'NoSeparator')).toBeNull()
    expect(matchPattern('%ARTIST% - %Title%', 'A - B')).toEqual({ artist: 'A', title: 'B' })
    expect(matchPattern('%source_type%: %title%', 'Lead Sheet: X')).toEqual({ source_type: 'Lead Sheet', title: 'X' })
  })
  it('parses and formats durations', () => {
    expect(parseDuration('3:25')).toBe(205)
    expect(parseDuration('1:02:03')).toBe(3723)
    expect(parseDuration('90')).toBe(90)
    expect(parseDuration('')).toBe(0)
    expect(formatDuration(205)).toBe('3:25')
    expect(formatDuration(3723)).toBe('1:02:03')
    expect(formatDuration(0)).toBe('')
  })
  it('maps folder levels from the end or from the root', () => {
    const path = 'Music/Jazz/Miles Davis/Kind of Blue/So What.pdf'
    expect(folderFields(path, '%artist%/%album%')).toEqual({ artist: 'Miles Davis', album: 'Kind of Blue' })
    expect(folderFields(path, '%genre%/%artist%', false)).toEqual({ genre: 'Music', artist: 'Jazz' })
    expect(folderFields('Jazz/x.pdf', '%genre%/%artist%')).toEqual({ artist: 'Jazz' })
    expect(folderFields('Jazz/x.pdf', '%genre%/%artist%', false)).toEqual({ genre: 'Jazz' })
    expect(folderFields('x.pdf', '%genre%')).toEqual({})
    expect(folderFields('Davis - Blue/x.pdf', '%artist% - %album%')).toEqual({ artist: 'Davis', album: 'Blue' })
  })
  it('previews titles and fields', () => {
    const file = new File(['x'], 'Miles Davis - So What.pdf')
    const p = previewSource({ file, path: 'Jazz/Miles Davis - So What.pdf' }, { filePattern: '%artist% - %title%', folderPattern: '%genre%' })
    expect(p.matched).toBe(true)
    expect(p.song.title).toBe('So What')
    expect(p.song.artists).toEqual(['Miles Davis'])
    expect(p.song.genres).toEqual(['Jazz'])
    expect(previewSource({ file }, { filePattern: '%title% (%key%)' })).toMatchObject({ matched: false, song: { title: 'Miles Davis - So What' } })
  })
  it('capitalizes words without lowering the rest', () => {
    expect(capitalizeWords('the long and winding road')).toBe('The Long And Winding Road')
    expect(capitalizeWords('AC/DC (live) rock-n-roll')).toBe('AC/DC (Live) Rock-N-Roll')
  })
  it('strips the picked root folder', () => {
    const f = new File(['x'], 'a.pdf')
    expect(stripCommonRoot([{ file: f, path: 'Root/A/a.pdf' }, { file: f, path: 'Root/b.pdf' }]).map((s) => s.path)).toEqual(['A/a.pdf', 'b.pdf'])
    expect(stripCommonRoot([{ file: f, path: 'a.pdf' }]).map((s) => s.path)).toEqual(['a.pdf'])
  })
})

describe('importFiles', () => {
  beforeEach(async () => {
    await db.songs.clear()
    await db.blobs.clear()
  })
  const txt = (name: string, body: string) => ({ file: new File([body], name, { type: 'text/plain' }) })

  it('reads plain-text sheet headers', async () => {
    const r = await importFiles([txt('sheet.txt', 'Title: Plain Song\nArtist: Someone\nKey: G\n\nG       C\nHello world\n')])
    expect(r.songs[0].title).toBe('Plain Song')
    expect(r.songs[0].artists).toEqual(['Someone'])
  })
  it('applies conflict policies by title', async () => {
    await importFiles([txt('A.cho', '{title: Alpha}\n[C]one')])
    const skip = await importFiles([txt('A2.cho', '{title: alpha}\n[C]two')], { conflict: 'skip' })
    expect(skip.songs).toHaveLength(0)
    expect(skip.skipped[0].reason).toMatch(/already exists/)
    const upd = await importFiles([txt('A3.cho', '{title: Alpha}\n{artist: Bob}\n[C]three')], { conflict: 'update' })
    expect(upd.updated).toHaveLength(1)
    expect(upd.updated[0].artists).toEqual(['Bob'])
    expect(upd.updated[0].files[0].name).toBe('A3.cho')
    // Same content again with "update": metadata from patterns still merges in (not skipped as duplicate).
    const again = await importFiles([{ file: new File(['{title: Alpha}\n{artist: Bob}\n[C]three'], 'A3.cho'), path: 'Rock/A3.cho' }], {
      conflict: 'update',
      skipDuplicates: true,
      folderPattern: '%genre%',
    })
    expect(again.skipped).toEqual([])
    expect(again.updated[0].genres).toEqual(['Rock'])
    const created = await importFiles([txt('A4.cho', '{title: Alpha}\n[C]four')])
    expect(created.songs).toHaveLength(1)
    expect(await db.songs.count()).toBe(2)
  })
  it('skips duplicate content and combines files', async () => {
    await importFiles([txt('x.txt', 'same')])
    const r = await importFiles([txt('y.txt', 'same'), txt('z.txt', 'other')], { skipDuplicates: true })
    expect(r.skipped.map((s) => s.name)).toEqual(['y.txt'])
    const c = await importFiles([txt('p1.txt', 'p1'), txt('p2.txt', 'p2')], { combine: true, collection: 'Book' })
    expect(c.songs).toHaveLength(1)
    expect(c.songs[0].files.map((f) => f.name)).toEqual(['p1.txt', 'p2.txt'])
    expect(c.songs[0].collections).toEqual(['Book'])
  })
})
