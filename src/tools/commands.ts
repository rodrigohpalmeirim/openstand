import { db, uid, updateSong } from '../db/db'
import type { LinkPoint, SmartButton, Song } from '../db/schema'
import { sendCommands } from '../midi/midi'
import { currentSongId, useViewer } from '../state/viewer'
import { toast } from '../ui/primitives'
import { ACTIONS, runAction, type ActionId } from '../viewer/actions'
import { goToPageWhenReady, viewerApi } from '../viewer/api'
import { player } from './audio/player'
import { useTools, type PagePoint } from './store'
import { openExternalUrl } from '../util/safeUrl'

/**
 * After a jump, bring the target position into view when the page is taller than the screen
 * (fit-width, zoomed or vertical strip). Runs after the viewer has re-rendered the new page.
 */
export function revealPoint(p: { pageIndex: number; y: number }) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const api = viewerApi()
      const el = api?.scroller
      if (!api || !el || !api.canScroll() || api.mode === 'horizontalScroll') return
      const pageEl = el.querySelector<HTMLElement>(`[data-page="${p.pageIndex}"]`)
      const top = pageEl ? pageEl.offsetTop : 0
      const height = pageEl ? pageEl.offsetHeight : el.scrollHeight
      el.scrollTo({ top: Math.max(0, top + p.y * height - el.clientHeight * 0.15) })
    }),
  )
}

/** Follow link `index` of the song. `go` is the viewer's own follow handler when called from a marker. */
export function followLink(song: Song, index: number, go?: (page: number) => void) {
  const link = song.links[index]
  if (!link) return
  useTools.setState({ linkPointer: index + 1 })
  if (go) go(link.to.pageIndex)
  else {
    const v = useViewer.getState()
    useViewer.setState({ linkReturn: [...v.linkReturn, v.position] })
    viewerApi()?.goToPage(link.to.pageIndex)
  }
  revealPoint(link.to)
}

/** Open a song: jump within the current queue if it's there, else insert it after the current song. */
export function jumpToSong(songId: string, page = 0) {
  const v = useViewer.getState()
  if (v.queue[v.index] === songId) {
    viewerApi()?.goToPage(page)
    return
  }
  const after = v.queue.indexOf(songId, v.index + 1)
  const at = after >= 0 ? after : v.queue.indexOf(songId)
  if (at >= 0) v.goSong(at)
  else {
    const queue = [...v.queue.slice(0, v.index + 1), songId, ...v.queue.slice(v.index + 1)]
    useViewer.setState({ queue })
    useViewer.getState().goSong(v.index + 1)
  }
  // Viewer positions are layout stops, not pages: let the viewer map the page once laid out.
  if (page > 0) goToPageWhenReady(songId, page)
}

export function describeButton(b: SmartButton, song?: Song): string {
  switch (b.kind) {
    case 'action':
      return ACTIONS[b.action as ActionId]?.label ?? 'Action'
    case 'page':
      return `Go to page ${(b.page ?? 0) + 1}`
    case 'song':
      return 'Open song'
    case 'audio':
      return `Play ${song?.audio.find((t) => t.id === b.trackId)?.name ?? 'audio'}`
    case 'midi':
      return `Send ${b.midi?.length ?? 0} MIDI message${b.midi?.length === 1 ? '' : 's'}`
    case 'url':
      return b.url || 'Open link'
  }
}

export async function runSmartButton(song: Song, b: SmartButton) {
  const idx = (song.smartButtons ?? []).findIndex((x) => x.id === b.id)
  if (idx >= 0) useTools.setState({ buttonPointer: idx + 1 })
  switch (b.kind) {
    case 'action':
      if (b.action && b.action in ACTIONS) runAction(b.action as ActionId, 'smart')
      return
    case 'page':
      viewerApi()?.goToPage(b.page ?? 0)
      return
    case 'song':
      if (b.songId) jumpToSong(b.songId, b.page ?? 0)
      return
    case 'audio': {
      const t = song.audio.find((x) => x.id === b.trackId) ?? song.audio[0]
      if (!t) return toast('This song has no audio tracks')
      useTools.setState({ playerVisible: true })
      await player.load(song, t, { play: true, at: b.start ?? 0 })
      return
    }
    case 'midi':
      if (b.midi?.length) await sendCommands(b.midi, { bpm: song.metronome?.bpm })
      return
    case 'url':
      // Synced/imported data: only http(s) may be opened (never javascript:, intent:, file:, app protocols).
      if (b.url && !openExternalUrl(b.url)) toast('This button’s link isn’t a web address (http/https), so it wasn’t opened', 'error')
      return
  }
}

/** Next/previous smart button in list order (for pedals). */
export function stepSmartButton(song: Song, dir: 1 | -1) {
  const list = song.smartButtons ?? []
  if (!list.length) return toast('This song has no smart buttons')
  const p = useTools.getState().buttonPointer
  const i = dir > 0 ? p : p - 2
  if (i < 0 || i >= list.length) return toast(dir > 0 ? 'No more smart buttons' : 'First smart button')
  void runSmartButton(song, list[i])
}

/* --------------------------------------------------------------- picking */

function finishPick(tab: 'links' | 'buttons') {
  useTools.setState({ pick: null, linksTab: tab })
  useViewer.setState({ panel: 'links' })
}

/** A location was tapped while a pick flow is active. */
export async function completePick(p: PagePoint) {
  const pick = useTools.getState().pick
  const id = currentSongId()
  if (!pick || !id) return
  const song = await db.songs.get(id)
  if (!song) return
  switch (pick.kind) {
    case 'linkFrom':
      useTools.setState({ pick: { kind: 'linkTo', from: p } })
      return
    case 'linkTo': {
      const link: LinkPoint = { id: uid(), from: pick.from, to: p }
      await updateSong(song.id, { links: [...song.links, link] })
      toast(`Link added: page ${pick.from.pageIndex + 1} → ${p.pageIndex + 1}`, 'ok')
      return finishPick('links')
    }
    case 'linkMove':
      await updateSong(song.id, { links: song.links.map((l) => (l.id === pick.linkId ? { ...l, [pick.end]: p } : l)) })
      return finishPick('links')
    case 'button': {
      const b: SmartButton = { ...pick.draft, ...p }
      const list = song.smartButtons ?? []
      const exists = list.some((x) => x.id === b.id)
      await updateSong(song.id, { smartButtons: exists ? list.map((x) => (x.id === b.id ? b : x)) : [...list, b] })
      if (!exists) toast('Button placed', 'ok')
      return finishPick('buttons')
    }
  }
}

export const PICK_PROMPTS: Record<string, string> = {
  linkFrom: 'Tap where the link starts (e.g. the repeat sign)',
  linkTo: 'Now tap where it jumps to',
  linkMove: 'Tap the new position',
  button: 'Tap where the button goes',
}
