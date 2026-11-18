import { Camera, Check, Crop, Images, Loader2, Maximize, Plus, RotateCw, Sparkles, Spline, Trash2, Undo2, Wand2, Zap, ZapOff } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useDragSort, moveItem } from '../library/editor/useDragSort'
import { Sheet } from '../library/editor/Sheet'
import { Button, confirmDialog, cx, Empty, IconButton, Segmented, Slider, toast } from '../ui/primitives'
import { cameraApiAvailable, hasCamera, openCamera, type CameraSession } from './camera'
import { CornerEditor } from './CornerEditor'
import { detectQuad } from './detect'
import { scanEngine } from './engine'
import { FULL_QUAD, isStraight, NO_BEND, type Bend, type Quad } from './geometry'
import { DEFAULT_PARAMS, toGrey, type Filter, type FilterParams } from './image'
import { buildScanPdf, type EncodedPage } from './pdf'
import type { RenderParams } from './processor'
import type { CorrectSession } from './correct'

interface Page {
  id: string
  blob: Blob
  url: string
  width: number
  height: number
  quad: Quad
  /** The automatically detected outline (null when detection failed). */
  auto: Quad | null
  rotation: number
  /** Curved paper edges (same photo frame as `quad`); absent or empty = straight. */
  bend?: Bend
  status: 'loading' | 'ready' | 'error'
  thumb?: string
}

type Mode = 'camera' | 'pick' | 'edit'
type View = 'corners' | 'result'

const PREFS_KEY = 'openstand:scan'
/** Filter a correction starts with: the page unchanged. */
const CORRECT_START: Partial<FilterParams> = { filter: 'color', brightness: 0, contrast: 0 }
let nextId = 0

function loadPrefs(): FilterParams {
  try {
    return { ...DEFAULT_PARAMS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }
  } catch {
    return DEFAULT_PARAMS
  }
}

function scanName(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `Scan ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`
}

const isTouch = () => typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0
/** "Take photo" (the system camera app) is only offered on touch devices. */
const photoChoice = () => (isTouch() ? 'take or choose photos' : 'choose photos')

/**
 * Camera scanner for paper sheet music: capture (or pick) photos, mark each page's corners,
 * straighten and clean them up, and get back one PDF.
 */
export function Scanner({
  title = 'Scan sheet music',
  onDone,
  onCancel,
  correct,
}: {
  title?: string
  onDone: (file: File) => void
  onCancel: () => void
  /** Correct the given pages of an existing file: no camera, no adding/removing/reordering pages. */
  correct?: CorrectSession
}) {
  const [pages, setPages] = useState<Page[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode | null>(correct ? 'edit' : null)
  const [cameraOk, setCameraOk] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [replaceId, setReplaceId] = useState<string | null>(null)
  // Correcting starts from the page as it is (original colours) and leaves the scanner's preferences alone.
  const [params, setParams] = useState<FilterParams>(() => (correct ? { ...loadPrefs(), ...CORRECT_START } : loadPrefs()))
  const [view, setView] = useState<View>('result')
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(null)
  const pickInput = useRef<HTMLInputElement>(null)
  const takeInput = useRef<HTMLInputElement>(null)
  const pagesRef = useRef(pages)
  useLayoutEffect(() => {
    pagesRef.current = pages
  })

  useEffect(() => {
    if (correct) return
    let live = true
    hasCamera().then((ok) => {
      if (!live) return
      setCameraOk(ok)
      setMode(ok ? 'camera' : 'pick')
    })
    return () => {
      live = false
    }
  }, [correct])

  // Release photos and worker memory when the scanner closes.
  useEffect(
    () => () => {
      for (const p of pagesRef.current) {
        URL.revokeObjectURL(p.url)
        scanEngine.drop(p.id)
      }
    },
    [],
  )

  useEffect(() => {
    if (correct) return
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(params))
    } catch {
      /* private mode */
    }
  }, [params, correct])

  const patch = useCallback((id: string, p: Partial<Page>) => setPages((ps) => ps.map((x) => (x.id === id ? { ...x, ...p } : x))), [])

  /** Add photos (or replace the page being retaken). Returns the first new page id. */
  const addBlobs = useCallback(
    (blobs: Blob[], replace: string | null = null) => {
      if (!blobs.length) return null
      const fresh: Page[] = blobs.map((blob) => ({
        id: `p${Date.now().toString(36)}${nextId++}`,
        blob,
        url: URL.createObjectURL(blob),
        width: 0,
        height: 0,
        quad: FULL_QUAD,
        auto: null,
        rotation: 0,
        status: 'loading',
      }))
      const old = replace ? pagesRef.current.find((p) => p.id === replace) : undefined
      if (old) {
        URL.revokeObjectURL(old.url)
        scanEngine.drop(old.id)
        setPages((ps) => ps.map((p) => (p.id === old.id ? fresh[0] : p)))
      } else setPages((ps) => [...ps, ...fresh])
      for (const p of replace ? fresh.slice(0, 1) : fresh)
        scanEngine
          .load(p.id, p.blob)
          .then((r) => patch(p.id, { width: r.width, height: r.height, quad: r.quad ?? FULL_QUAD, auto: r.quad, status: 'ready' }))
          .catch((e) => {
            console.warn('scan: could not load photo', e)
            patch(p.id, { status: 'error' })
            toast("Couldn't read that image", 'error')
          })
      return fresh[0].id
    },
    [patch],
  )

  // Correcting: the file's pages, each starting with the whole page as its outline (Detect stays
  // available) and its saved rotation. Loaded one at a time so long PDFs don't decode all at once.
  const started = useRef(false)
  const closed = useRef(false)
  useEffect(() => {
    closed.current = false
    return () => {
      closed.current = true
    }
  }, [])
  useEffect(() => {
    if (!correct || started.current) return
    started.current = true
    const fresh: Page[] = correct.pages.map((src) => ({
      id: `p${Date.now().toString(36)}${nextId++}`,
      blob: src.blob,
      url: URL.createObjectURL(src.blob),
      width: 0,
      height: 0,
      quad: FULL_QUAD,
      auto: null,
      rotation: ((src.rotation % 4) + 4) % 4,
      status: 'loading',
    }))
    setPages(fresh)
    setSel(fresh[0]?.id ?? null)
    void (async () => {
      for (const p of fresh) {
        if (closed.current) return
        try {
          const r = await scanEngine.load(p.id, p.blob)
          if (closed.current) return scanEngine.drop(p.id)
          patch(p.id, { width: r.width, height: r.height, auto: r.quad, status: 'ready' })
        } catch (e) {
          console.warn('correct: could not load page', e)
          patch(p.id, { status: 'error' })
        }
      }
    })()
  }, [correct, patch])

  const picked = (files: FileList | null) => {
    const list = [...(files ?? [])].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|avif|bmp|gif)$/i.test(f.name))
    if (!list.length) return
    const id = addBlobs(list, replaceId)
    setReplaceId(null)
    if (id) setSel(id)
    setMode('edit')
  }

  const selIndex = pages.findIndex((p) => p.id === sel)
  const page = selIndex >= 0 ? pages[selIndex] : pages[0]

  // When a page is opened, show the result if the outline was found automatically, else the corners.
  const lastSel = useRef<string | null>(null)
  useEffect(() => {
    if (!page || page.status !== 'ready' || lastSel.current === page.id) return
    lastSel.current = page.id
    setView(page.auto || correct ? 'result' : 'corners')
  }, [page, correct])

  const remove = (id: string) => {
    const ps = pagesRef.current
    const i = ps.findIndex((p) => p.id === id)
    if (i < 0) return
    URL.revokeObjectURL(ps[i].url)
    scanEngine.drop(id)
    const next = ps.filter((x) => x.id !== id)
    setPages(next)
    if (id === page?.id) setSel(next[Math.min(i, next.length - 1)]?.id ?? null)
    if (!next.length) setMode(cameraOk ? 'camera' : 'pick')
  }

  const addMore = () => {
    setReplaceId(null)
    if (cameraOk) setMode('camera')
    else pickInput.current?.click()
  }
  const retake = (id: string) => {
    setReplaceId(id)
    if (cameraOk) setMode('camera')
    else (isTouch() ? takeInput : pickInput).current?.click()
  }

  const close = async () => {
    if (saving) return
    if (correct) {
      const start = { ...params, ...CORRECT_START }
      const edited =
        JSON.stringify(params) !== JSON.stringify(start) ||
        pagesRef.current.some((p, i) => JSON.stringify(p.quad) !== JSON.stringify(FULL_QUAD) || !isStraight(p.bend) || p.rotation !== (((correct.pages[i]?.rotation ?? 0) % 4) + 4) % 4)
      if (edited && !(await confirmDialog({ title: 'Discard your corrections?', message: 'The file stays as it was.', confirmLabel: 'Discard', danger: true }))) return
      return onCancel()
    }
    if (pagesRef.current.length && !(await confirmDialog({ title: 'Discard this scan?', message: 'The pages of this scan will be lost.', confirmLabel: 'Discard', danger: true })))
      return
    onCancel()
  }

  const saveBusy = useRef(false)
  const saveCorrections = async (session: CorrectSession) => {
    if (saveBusy.current) return
    saveBusy.current = true
    const ps = pagesRef.current
    try {
      const ok = await session.save({
        edits: ps.map((p) => ({ quad: p.quad, bend: p.bend, rotation: p.rotation, ready: p.status === 'ready' })),
        params,
        exportPage: (i, extra) => scanEngine.exportPage(ps[i].id, { ...params, quad: ps[i].quad, bend: ps[i].bend, rotation: 0, ...extra }),
        progress: (done, total) => setSaving({ done, total }),
      })
      if (!ok) setSaving(null)
    } catch (e) {
      console.error(e)
      toast(`Couldn't save the corrected pages: ${(e as Error).message}`, 'error')
      setSaving(null)
    } finally {
      saveBusy.current = false
    }
  }

  const save = async () => {
    if (correct) return saveCorrections(correct)
    const ready = pages.filter((p) => p.status === 'ready')
    if (!ready.length) return
    const bad = pages.filter((p) => p.status === 'error').length
    if (
      bad &&
      !(await confirmDialog({
        title: `Leave out ${bad} unreadable page${bad === 1 ? '' : 's'}?`,
        message: `${bad === 1 ? 'One photo' : `${bad} photos`} couldn't be read, so the PDF will have ${ready.length} page${ready.length === 1 ? '' : 's'}.`,
        confirmLabel: 'Save PDF',
      }))
    )
      return
    setSaving({ done: 0, total: ready.length })
    try {
      const out: EncodedPage[] = []
      for (const p of ready) {
        out.push(await scanEngine.exportPage(p.id, { ...params, quad: p.quad, rotation: p.rotation, bend: p.bend }))
        setSaving({ done: out.length, total: ready.length })
      }
      const name = scanName()
      const bytes = await buildScanPdf(out, name)
      onDone(new File([bytes as Uint8Array<ArrayBuffer>], `${name}.pdf`, { type: 'application/pdf' }))
    } catch (e) {
      console.error(e)
      toast(`Couldn't create the PDF: ${(e as Error).message}`, 'error')
      setSaving(null)
    }
  }

  const ready = pages.filter((p) => p.status === 'ready').length
  const loading = pages.some((p) => p.status === 'loading')

  return (
    <Sheet
      onClose={close}
      title={title}
      size="full"
      subtitle={mode === 'edit' && page ? `Page ${Math.max(0, selIndex) + 1} of ${pages.length}` : mode === 'camera' ? (replaceId ? 'Retake page' : `${pages.length} page${pages.length === 1 ? '' : 's'}`) : undefined}
      bodyClassName="flex flex-col overflow-hidden"
      actions={
        mode === 'edit' && (
          <Button variant="primary" onClick={save} disabled={!ready || loading || !!saving} icon={<Check className="size-4" />}>
            {correct ? correct.saveLabel : 'Save PDF'}
          </Button>
        )
      }
    >
      <input ref={pickInput} type="file" accept="image/*" multiple={!replaceId} hidden onChange={(e) => (picked(e.target.files), (e.target.value = ''))} />
      <input ref={takeInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => (picked(e.target.files), (e.target.value = ''))} />

      {mode === null && <Spinner label="Starting…" />}

      {mode === 'pick' && (
        <div className="flex flex-1 items-center justify-center overflow-y-auto">
          <Empty icon={<Camera className="size-6" />} title="Scan sheet music">
            {cameraError ?? 'Photograph printed music, then straighten and clean up each page. Works with photos you already have, too.'}
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {isTouch() && (
                <Button variant="primary" icon={<Camera className="size-4" />} onClick={() => takeInput.current?.click()}>
                  Take photo
                </Button>
              )}
              <Button variant={isTouch() ? 'secondary' : 'primary'} icon={<Images className="size-4" />} onClick={() => pickInput.current?.click()}>
                Choose photos
              </Button>
              {pages.length > 0 && (
                <Button variant="ghost" onClick={() => setMode('edit')}>
                  Back to pages
                </Button>
              )}
            </div>
          </Empty>
        </div>
      )}

      {mode === 'camera' && (
        <CameraStage
          count={pages.length}
          lastThumb={pages[pages.length - 1]?.thumb ?? pages[pages.length - 1]?.url}
          replacing={!!replaceId}
          onShot={(blob) => {
            const id = addBlobs([blob], replaceId)
            if (replaceId) {
              setReplaceId(null)
              if (id) setSel(id)
              setMode('edit')
            }
          }}
          onPick={() => pickInput.current?.click()}
          onDone={() => {
            if (replaceId) setReplaceId(null)
            if (!pagesRef.current.length) return
            setSel((s) => s ?? pagesRef.current[0].id)
            setMode('edit')
          }}
          onFail={(msg) => {
            setCameraOk(false)
            setCameraError(msg)
            setMode(pagesRef.current.length ? 'edit' : 'pick')
            if (pagesRef.current.length) toast(msg, 'error')
          }}
        />
      )}

      {mode === 'edit' && page && (
        <EditStage
          page={page}
          view={view}
          setView={setView}
          params={params}
          setParams={setParams}
          onQuad={(q) => patch(page.id, { quad: q })}
          onBend={(bend) => patch(page.id, { bend })}
          onRotate={() => patch(page.id, { rotation: (page.rotation + 1) % 4 })}
          onRetake={() => retake(page.id)}
          onDelete={() => remove(page.id)}
          canRetake={!correct && (cameraOk || isTouch())}
          correcting={!!correct}
        />
      )}
      {mode === 'edit' && (
        <PageStrip
          pages={pages}
          selected={page?.id ?? null}
          onSelect={setSel}
          onReorder={correct ? undefined : (from, to) => setPages((ps) => moveItem(ps, from, to))}
          onAdd={correct ? undefined : addMore}
        />
      )}
      <ThumbRenderer pages={pages} params={params} onThumb={(id, thumb) => patch(id, { thumb })} />

      {saving && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50">
          <div className="flex items-center gap-3 rounded-xl bg-surface px-5 py-4 text-sm shadow-xl" role="status">
            <Loader2 className="size-5 animate-spin text-accent" />
            {saving.done < saving.total ? `${correct ? 'Correcting' : 'Processing'} page ${saving.done + 1} of ${saving.total}…` : correct ? 'Replacing the file…' : 'Creating PDF…'}
          </div>
        </div>
      )}
    </Sheet>
  )
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted" role="status">
      <Loader2 className="size-5 animate-spin" />
      {label}
    </div>
  )
}

/* ----------------------------------------------------------------- Camera */

function CameraStage({
  count,
  lastThumb,
  replacing,
  onShot,
  onPick,
  onDone,
  onFail,
}: {
  count: number
  lastThumb?: string
  replacing: boolean
  onShot: (b: Blob) => void
  onPick: () => void
  onDone: () => void
  onFail: (message: string) => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [session, setSession] = useState<CameraSession | null>(null)
  const [torch, setTorch] = useState(false)
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState(false)
  const [outline, setOutline] = useState<{ q: Quad; w: number; h: number } | null>(null)
  const failRef = useRef(onFail)
  useLayoutEffect(() => {
    failRef.current = onFail
  })

  useEffect(() => {
    let dead = false
    let s: CameraSession | null = null
    if (!cameraApiAvailable()) {
      failRef.current(`This browser has no camera access here. You can still ${photoChoice()}.`)
      return
    }
    openCamera()
      .then(async (sess) => {
        if (dead) return sess.stop()
        s = sess
        const v = video.current!
        v.srcObject = sess.stream
        await v.play().catch(() => {})
        setSession(sess)
      })
      .catch((e: Error) => {
        if (dead) return
        const denied = e?.name === 'NotAllowedError' || e?.name === 'SecurityError'
        failRef.current(`${denied ? 'Camera permission was denied.' : "Couldn't start the camera."} You can still ${photoChoice()}.`)
      })
    return () => {
      dead = true
      s?.stop()
    }
  }, [])

  // Live page outline: a cheap detection on a tiny frame a few times a second.
  useEffect(() => {
    if (!session) return
    const c = document.createElement('canvas')
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    const t = setInterval(() => {
      const v = video.current
      if (!v?.videoWidth || document.hidden) return
      const k = 200 / Math.max(v.videoWidth, v.videoHeight)
      c.width = Math.round(v.videoWidth * k)
      c.height = Math.round(v.videoHeight * k)
      ctx.drawImage(v, 0, 0, c.width, c.height)
      const d = ctx.getImageData(0, 0, c.width, c.height)
      const q = detectQuad(toGrey(d), c.width, c.height)
      setOutline(q && { q, w: v.videoWidth, h: v.videoHeight })
    }, 350)
    return () => clearInterval(t)
  }, [session])

  const shoot = async () => {
    if (!session || busy || !video.current) return
    setBusy(true)
    setFlash(true)
    setTimeout(() => setFlash(false), 140)
    navigator.vibrate?.(15)
    try {
      onShot(await session.capture(video.current))
    } catch {
      toast('Capture failed — try again', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-black text-white">
      <div className="relative min-h-0 flex-1">
        <video ref={video} playsInline muted autoPlay className="absolute inset-0 h-full w-full object-contain" />
        {outline && (
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${outline.w} ${outline.h}`} preserveAspectRatio="xMidYMid meet" aria-hidden>
            <polygon
              points={outline.q.map((p) => `${p.x * outline.w},${p.y * outline.h}`).join(' ')}
              fill="rgba(251,146,60,0.12)"
              stroke="#fb923c"
              strokeWidth={Math.max(outline.w, outline.h) / 250}
              strokeLinejoin="round"
            />
          </svg>
        )}
        {flash && <div className="absolute inset-0 bg-white/70" />}
        {!session && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white/70">
            <Loader2 className="size-5 animate-spin" /> Starting camera…
          </div>
        )}
        {session && (
          <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
            <span className="rounded-full bg-black/50 px-3 py-1 text-xs text-white/90">{outline ? 'Page found — hold steady' : 'Fit the whole page in the frame'}</span>
          </div>
        )}
        {session?.torch && (
          <button
            type="button"
            aria-label={torch ? 'Turn torch off' : 'Turn torch on'}
            aria-pressed={torch}
            className={cx('absolute right-3 top-3 flex size-11 items-center justify-center rounded-full', torch ? 'bg-white text-black' : 'bg-black/50 text-white')}
            onClick={() => {
              session.setTorch(!torch).then(
                () => setTorch(!torch),
                () => toast("Couldn't switch the torch", 'error'),
              )
            }}
          >
            {torch ? <Zap className="size-5" /> : <ZapOff className="size-5" />}
          </button>
        )}
      </div>
      <div data-bottom-bar className="flex shrink-0 items-center justify-between px-6 pt-4" style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
        <button type="button" onClick={onPick} aria-label="Choose photos" title="Choose photos" className="flex size-12 items-center justify-center rounded-full bg-white/10 hover:bg-white/20">
          <Images className="size-5" />
        </button>
        <button
          type="button"
          onClick={shoot}
          disabled={!session || busy}
          aria-label="Take photo"
          className="flex size-[72px] items-center justify-center rounded-full border-4 border-white/90 transition active:scale-95 disabled:opacity-40"
        >
          <span className={cx('block size-14 rounded-full bg-white transition', busy && 'scale-75 opacity-70')} />
        </button>
        {replacing ? (
          <button type="button" onClick={onDone} className="h-12 min-w-12 rounded-full bg-white/10 px-4 text-sm font-medium hover:bg-white/20">
            Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={onDone}
            disabled={!count}
            aria-label={`Done, review ${count} page${count === 1 ? '' : 's'}`}
            className="relative flex size-12 items-center justify-center overflow-hidden rounded-lg border-2 border-white/80 bg-white/10 disabled:opacity-30"
          >
            {lastThumb ? <img src={lastThumb} alt="" className="h-full w-full object-cover" /> : <Check className="size-5" />}
            {count > 0 && <span className="absolute -right-0 -top-0 rounded-bl-md bg-accent px-1.5 text-xs font-semibold text-accent-fg">{count}</span>}
          </button>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------- Edit */

const FILTERS: { value: Filter; label: string; title: string }[] = [
  { value: 'color', label: 'Colour', title: 'Original colours' },
  { value: 'grey', label: 'Grey', title: 'Greyscale with shadows removed' },
  { value: 'bw', label: 'B&W', title: 'Clean black & white — smallest files, crisp staff lines' },
]

function EditStage({
  page,
  view,
  setView,
  params,
  setParams,
  onQuad,
  onBend,
  onRotate,
  onRetake,
  onDelete,
  canRetake,
  correcting = false,
}: {
  page: Page
  view: View
  setView: (v: View) => void
  params: FilterParams
  setParams: (p: FilterParams) => void
  onQuad: (q: Quad) => void
  onBend: (b: Bend) => void
  onRotate: () => void
  onRetake: () => void
  onDelete: () => void
  canRetake: boolean
  /** Pages of an existing file: they can't be deleted. */
  correcting?: boolean
}) {
  const set = (p: Partial<FilterParams>) => setParams({ ...params, ...p })
  // Curvature from the staff lines: only on request, and only applied if the page and corners haven't moved meanwhile.
  const [bending, setBending] = useState(false)
  const latest = useRef(page)
  useLayoutEffect(() => {
    latest.current = page
  })
  const findCurve = async () => {
    const { id, quad, rotation, bend } = page
    setBending(true)
    try {
      const est = await scanEngine.estimateBend(id, quad, rotation, bend)
      const now = latest.current
      if (now.id !== id || now.quad !== quad || now.rotation !== rotation || now.bend !== bend) return
      if (!est) toast("Couldn't measure the curve: it needs clear staff lines and corners placed on the paper's corners. You can pull the small dots onto the page edges instead.")
      else {
        onBend(est.bend)
        if (est.flat) toast('The staff lines already look straight')
      }
    } catch {
      toast("Couldn't measure the curve", 'error')
    } finally {
      setBending(false)
    }
  }
  return (
    <>
      <div className="relative min-h-0 flex-1 bg-surface-2">
        {page.status === 'loading' && <Spinner label={correcting ? 'Reading page…' : 'Reading photo…'} />}
        {page.status === 'error' && (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted">
            {correcting ? "This page couldn't be read here. It will be kept as it is." : <>This photo couldn't be read. {canRetake ? 'Retake it or delete the page.' : 'Delete the page, or add another photo.'}</>}
          </div>
        )}
        {page.status === 'ready' &&
          (view === 'corners' ? (
            <CornerEditor url={page.url} width={page.width} height={page.height} quad={page.quad} onChange={onQuad} bend={page.bend} onBendChange={onBend} rotation={page.rotation} />
          ) : (
            <ResultView page={page} params={params} />
          ))}
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-t border-line px-3 py-2">
        <div className="flex items-center gap-2">
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: 'corners', label: <><Crop className="size-3.5" /> Corners</>, title: 'Mark the corners of the paper' },
              { value: 'result', label: <><Sparkles className="size-3.5" /> Result</>, title: 'Straightened and cleaned page' },
            ]}
          />
          <div className="flex-1" />
          <IconButton label="Rotate page" onClick={onRotate} disabled={page.status !== 'ready'}>
            <RotateCw className="size-5" />
          </IconButton>
          {canRetake && (
            <IconButton label="Retake page" onClick={onRetake}>
              <Camera className="size-5" />
            </IconButton>
          )}
          {!correcting && (
            <IconButton label="Delete page" onClick={onDelete}>
              <Trash2 className="size-5" />
            </IconButton>
          )}
        </div>
        {view === 'corners' ? (
          <div className="flex min-h-10 flex-wrap items-center gap-2">
            <Button
              size="sm"
              icon={<Wand2 className="size-4" />}
              disabled={page.status !== 'ready'}
              onClick={() => (page.auto ? (onQuad(page.auto), onBend(NO_BEND)) : toast("Couldn't find the page edges — drag the corners instead"))}
            >
              Detect
            </Button>
            <Button size="sm" icon={<Maximize className="size-4" />} disabled={page.status !== 'ready'} onClick={() => (onQuad(FULL_QUAD), onBend(NO_BEND))}>
              {correcting ? 'Whole page' : 'Whole photo'}
            </Button>
            <Button
              size="sm"
              icon={bending ? <Loader2 className="size-4 animate-spin" /> : <Spline className="size-4" />}
              disabled={page.status !== 'ready' || bending}
              onClick={findCurve}
              title="Bend the top and bottom edges to straighten the staff lines (sheet music only)"
              aria-label="Find curve"
            >
              <span className="max-sm:hidden">Find curve</span>
            </Button>
            {!isStraight(page.bend) && (
              // Icon-only on phones so it fits the existing row: a new row would shrink the photo mid-drag.
              <Button size="sm" icon={<Undo2 className="size-4" />} onClick={() => onBend(NO_BEND)} title="Make the page edges straight again" aria-label="Straight edges">
                <span className="max-sm:hidden">Straight edges</span>
              </Button>
            )}
            <span className="text-xs text-muted max-sm:hidden">Drag the corners onto the paper. Curved page? Pull the small dots onto its edge.</span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Segmented value={params.filter} onChange={(filter) => set({ filter })} options={FILTERS} />
            {params.filter === 'bw' ? (
              <LabeledSlider label="Threshold" hint="Raise it if thin lines break up; lower it to remove smudges" value={params.threshold} min={0} max={100} onChange={(threshold) => set({ threshold })} />
            ) : (
              <>
                <LabeledSlider label="Brightness" value={params.brightness} min={-100} max={100} onChange={(brightness) => set({ brightness })} />
                <LabeledSlider label="Contrast" value={params.contrast} min={-100} max={100} onChange={(contrast) => set({ contrast })} />
              </>
            )}
          </div>
        )}
      </div>
    </>
  )
}

function LabeledSlider({ label, hint, value, min, max, onChange }: { label: string; hint?: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="flex min-h-10 min-w-[200px] flex-1 items-center gap-3" title={hint}>
      <span className="w-20 shrink-0 text-xs font-medium text-muted">{label}</span>
      <Slider label={label} value={value} min={min} max={max} onChange={onChange} />
      <button
        type="button"
        className="w-8 shrink-0 text-right text-xs tabular-nums text-faint hover:text-fg"
        title="Reset"
        onClick={(e) => {
          e.preventDefault()
          onChange(min < 0 ? 0 : 50)
        }}
      >
        {value}
      </button>
    </label>
  )
}

/** Live preview of the processed page; renders are coalesced so sliders stay responsive. */
function ResultView({ page, params }: { page: Page; params: FilterParams }) {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [busy, setBusy] = useState(true)
  const [zoom, setZoom] = useState(false)
  const [bmp, setBmp] = useState<ImageBitmap | null>(null)
  const [boxSize, setBoxSize] = useState({ w: 0, h: 0 })
  const want = useMemo<{ id: string; p: RenderParams }>(() => ({ id: page.id, p: { ...params, quad: page.quad, rotation: page.rotation, bend: page.bend } }), [page.id, page.quad, page.rotation, page.bend, params])
  const wantRef = useRef(want)
  const running = useRef(false)
  const again = useRef(false)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )
  // Free the previous bitmap when a new one replaces it (and on unmount).
  useEffect(() => () => bmp?.close(), [bmp])

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setBoxSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const kick = useCallback(async () => {
    if (running.current) {
      again.current = true
      return
    }
    running.current = true
    setBusy(true)
    try {
      do {
        again.current = false
        const { id, p } = wantRef.current
        const el = box.current
        // Thin staff lines only survive thresholding with enough pixels, so B&W previews stay large even on small screens.
        const fit = Math.max(el?.clientWidth ?? 800, el?.clientHeight ?? 800) * (window.devicePixelRatio || 1)
        const long = Math.round(p.filter === 'bw' ? 2000 : Math.min(1600, Math.max(600, fit)))
        const next = await scanEngine.render(id, p, long)
        if (alive.current && !again.current) setBmp(next)
        else next.close()
      } while (again.current && alive.current)
    } catch (e) {
      console.warn('scan preview failed', e)
    } finally {
      running.current = false
      if (alive.current) setBusy(false)
    }
  }, [])

  useEffect(() => {
    wantRef.current = want
    kick()
  }, [want, kick])

  // Draw at the displayed size with high-quality resampling: letting CSS shrink a large B&W bitmap
  // would drop thin staff lines from the preview.
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  const pad = boxSize.w < 640 ? 12 : 20
  const fitScale = bmp ? Math.min((boxSize.w - pad * 2) / bmp.width, (boxSize.h - pad * 2) / bmp.height, 1 / dpr) : 0
  const css = bmp && (zoom ? { w: bmp.width / Math.min(1.5, dpr), h: bmp.height / Math.min(1.5, dpr) } : { w: bmp.width * fitScale, h: bmp.height * fitScale })
  useLayoutEffect(() => {
    const c = canvas.current
    if (!c || !bmp || !css || css.w <= 0) return
    c.width = Math.min(bmp.width, Math.round(css.w * dpr))
    c.height = Math.min(bmp.height, Math.round(css.h * dpr))
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, 0, 0, c.width, c.height)
  }, [bmp, css?.w, css?.h, dpr]) // oxlint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={box} className={cx('absolute inset-0', zoom ? 'overflow-auto' : 'flex items-center justify-center overflow-hidden')}>
      <canvas
        ref={canvas}
        onClick={() => setZoom((z) => !z)}
        title={zoom ? 'Click to fit' : 'Click to zoom in'}
        className={cx('shrink-0 bg-white shadow-lg ring-1 ring-black/10', zoom ? 'm-auto cursor-zoom-out' : 'cursor-zoom-in', !bmp && 'invisible')}
        style={css ? { width: css.w, height: css.h } : undefined}
      />
      {busy && (
        <div className="pointer-events-none absolute right-3 top-3 rounded-full bg-surface/90 p-1.5 shadow">
          <Loader2 className="size-4 animate-spin text-muted" />
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ Strip */

function PageStrip({
  pages,
  selected,
  onSelect,
  onReorder,
  onAdd,
}: {
  pages: Page[]
  selected: string | null
  onSelect: (id: string) => void
  /** Absent: the order is fixed (correcting a file's pages). */
  onReorder?: (from: number, to: number) => void
  onAdd?: () => void
}) {
  const sort = useDragSort(onReorder ?? (() => {}), { longPress: true })
  return (
    <div data-bottom-bar className="shrink-0 border-t border-line bg-surface" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <ol ref={sort.ref} className="flex gap-2 overflow-x-auto px-3 py-2" aria-label="Scanned pages">
        {pages.map((p, i) => (
          <li key={p.id} data-sort-index={i} className="shrink-0">
            <button
              type="button"
              onPointerDown={onReorder && sort.onPointerDown(i)}
              onClick={() => onSelect(p.id)}
              aria-label={`Page ${i + 1}`}
              aria-current={p.id === selected ? 'true' : undefined}
              className={cx(
                'relative flex h-[76px] w-14 items-center justify-center overflow-hidden rounded-md border bg-surface-2 transition',
                p.id === selected ? 'border-accent ring-2 ring-accent' : 'border-line hover:border-faint',
                sort.dragging === i && 'scale-105 shadow-lg',
              )}
            >
              {p.thumb ? <img src={p.thumb} alt="" draggable={false} className="max-h-full max-w-full" /> : p.status === 'error' ? <span className="text-xs text-danger">!</span> : <Loader2 className="size-4 animate-spin text-faint" />}
              <span className="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 text-[10px] font-semibold leading-4 text-white">{i + 1}</span>
            </button>
          </li>
        ))}
        {onAdd && (
          <li className="shrink-0">
            <button
              type="button"
              onClick={onAdd}
              className="flex h-[76px] w-14 flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-line text-muted transition hover:border-accent hover:text-accent"
            >
              <Plus className="size-5" />
              <span className="text-[10px] font-medium">Add</span>
            </button>
          </li>
        )}
      </ol>
    </div>
  )
}

/** Keeps small processed thumbnails up to date, one render at a time in the background. */
function ThumbRenderer({ pages, params, onThumb }: { pages: Page[]; params: FilterParams; onThumb: (id: string, url: string) => void }) {
  const done = useRef(new Map<string, string>())
  const running = useRef(false)
  const latest = useRef({ pages, params })
  const onThumbRef = useRef(onThumb)
  useLayoutEffect(() => {
    latest.current = { pages, params }
    onThumbRef.current = onThumb
  })
  useEffect(() => {
    const next = () => {
      const { pages: ps, params: pr } = latest.current
      return ps.find((p) => p.status === 'ready' && done.current.get(p.id) !== key(p, pr))
    }
    const loop = async () => {
      if (running.current) return
      running.current = true
      try {
        for (let todo = next(); todo; todo = next()) {
          const k = key(todo, latest.current.params)
          // Let quick successive edits (dragging a corner, moving a slider) settle first.
          await new Promise((r) => setTimeout(r, 150))
          const now = latest.current.pages.find((p) => p.id === todo!.id)
          if (!now || key(now, latest.current.params) !== k) continue
          try {
            const bmp = await scanEngine.render(now.id, { ...latest.current.params, quad: now.quad, rotation: now.rotation, bend: now.bend }, 520)
            const c = document.createElement('canvas')
            c.width = bmp.width
            c.height = bmp.height
            c.getContext('2d')!.drawImage(bmp, 0, 0)
            bmp.close()
            onThumbRef.current(now.id, c.toDataURL('image/jpeg', 0.75))
          } catch {
            /* page dropped meanwhile */
          }
          done.current.set(now.id, k)
        }
      } finally {
        running.current = false
      }
      // Changes that arrived while the last render finished.
      if (next()) loop()
    }
    loop()
  })
  return null
}

const key = (p: Page, pr: FilterParams) => JSON.stringify([p.quad, p.rotation, pr, isStraight(p.bend) ? null : p.bend])
