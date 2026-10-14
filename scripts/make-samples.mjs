// Generates sample files for manual testing and demos: a multi-page "score" PDF with staves and
// page labels, a ChordPro song and an ABC tune. All content is generated (no third-party music).
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples')
mkdirSync(out, { recursive: true })

async function score(title, composer, pages, [W, H] = [612, 792]) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.TimesRoman)
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold)
  const systems = Math.floor((H - 100) / 78)
  const bar = (W - 100) / 4
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([W, H])
    if (p === 0) {
      page.drawText(title, { x: W / 2 - bold.widthOfTextAtSize(title, 26) / 2, y: H - 62, size: 26, font: bold })
      page.drawText(composer, { x: W - 52 - font.widthOfTextAtSize(composer, 12), y: H - 87, size: 12, font })
    }
    const top = p === 0 ? H - 122 : H - 52
    for (let sys = 0; sys < (p === 0 ? systems - 1 : systems); sys++) {
      const y0 = top - sys * 78
      for (let l = 0; l < 5; l++) page.drawLine({ start: { x: 50, y: y0 - l * 7 }, end: { x: W - 50, y: y0 - l * 7 }, thickness: 0.6 })
      for (let b = 0; b <= 4; b++) page.drawLine({ start: { x: 50 + b * bar, y: y0 }, end: { x: 50 + b * bar, y: y0 - 28 }, thickness: 0.8 })
      // a few deterministic "notes"
      for (let n = 0; n < 16; n++) {
        const x = 64 + (n * (W - 120)) / 16 + (n % 4 === 0 ? 4 : 0)
        const step = ((n * 7 + sys * 3 + p * 5) % 9) - 1
        const y = y0 - 28 + step * 3.5
        page.drawEllipse({ x, y, xScale: 4, yScale: 3, color: rgb(0, 0, 0) })
        page.drawLine({ start: { x: x + 3.6, y }, end: { x: x + 3.6, y: y + 22 }, thickness: 0.8 })
      }
      page.drawText(String(sys * 4 + 1 + p * 36), { x: 44, y: y0 + 6, size: 7, font })
    }
    const label = `Page ${p + 1}`
    page.drawText(label, { x: W / 2 - font.widthOfTextAtSize(label, 10) / 2, y: 28, size: 10, font, color: rgb(0.4, 0.4, 0.4) })
  }
  return doc.save()
}

writeFileSync(join(out, 'Sonata in C - Demo Composer.pdf'), await score('Sonata in C', 'Demo Composer', 5))
writeFileSync(join(out, 'Evening Waltz - Demo Composer.pdf'), await score('Evening Waltz', 'Demo Composer', 2))
writeFileSync(join(out, 'Blues for Practice - Ensemble.pdf'), await score('Blues for Practice', 'Ensemble', 3))
writeFileSync(join(out, 'Landscape Etude - Demo Composer.pdf'), await score('Landscape Etude', 'Demo Composer', 3, [792, 612]))
writeFileSync(join(out, 'Big Book - Anthology.pdf'), await score('Big Book', 'Anthology', 40))

// A short practice track (2s of A440 with a click on every beat at 120 bpm), 16-bit mono WAV.
function wav(seconds = 4, rate = 22050) {
  const n = seconds * rate
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const click = t % 0.5 < 0.01 ? 0.6 : 0
    buf.writeInt16LE(Math.round((Math.sin(2 * Math.PI * 440 * t) * 0.25 + click) * 32767 * 0.8), 44 + i * 2)
  }
  return buf
}
writeFileSync(join(out, 'Practice Track.wav'), wav())

writeFileSync(
  join(out, 'Morning Light.cho'),
  `{title: Morning Light}
{subtitle: An OpenStand demo song}
{artist: The Placeholders}
{key: G}
{tempo: 96}
{time: 4/4}
{capo: 0}

{start_of_verse: Verse 1}
[G]Morning light comes [D/F#]through the window
[Em]Coffee's warm and the [C]day is new
[G]Every road I [D]ever wandered
[C]Somehow [D]led me back to [G]you
{end_of_verse}

{start_of_chorus}
[C]Sing it [D]loud, [G]sing it [Em]clear
[C]All the [D]songs we [G]keep right here
[Am]Turn the [D]page, the [G]band plays [Em]on
[C]Morning [D]light, a [G]brand new song
{end_of_chorus}

{start_of_verse: Verse 2}
[G]Paper maps and [D/F#]borrowed guitars
[Em]Setlists scribbled on a [C]napkin's back
[G]Every chord we [D]ever stumbled
[C]Found its [D]way back on [G]track
{end_of_verse}

{chorus}

{start_of_bridge}
[Em]Hold the [D]note a little [C]longer
[Em]Let the [D]room fall [C]still
[Am]One more [D]time
{end_of_bridge}

{chorus}

{c: Outro — repeat last line and ritard.}
`,
)

writeFileSync(
  join(out, 'Plain Chord Sheet.txt'),
  `Title: Plain Chord Sheet
Artist: Text Import Demo
Key: D

Verse:
D            A           Bm        G
Plain text sheets work just like the ones you print
D            A              G     A
Chords above the lyrics are detected automatically

Chorus:
G        A         D     Bm
Transpose me, I'm ready to go
G        A          D
Any key you like for the show
`,
)

writeFileSync(
  join(out, 'Speed the Plough.abc'),
  `X:1
T:Speed the Plough
C:Traditional
M:4/4
L:1/8
Q:1/4=120
R:Reel
K:G
|:GABc dedB|dedB dedB|c2ec B2dB|c2A2 A2BA|
GABc dedB|dedB dedB|c2ec B2dB|A2F2 G4:|
|:g2gf gdBd|g2f2 e2d2|c2ec B2dB|c2A2 A2df|
g2gf g2Bd|g2f2 e2d2|c2ec B2dB|A2F2 G4:|
`,
)
// A long ChordPro song that needs several pages/columns, with explicit column and page breaks.
const verses = Array.from({ length: 9 }, (_, v) =>
  `{start_of_verse: Verse ${v + 1}}
[A]Line one of verse ${v + 1} with a [E]fairly long lyric that [F#m]may need to wrap on [D]phones
[A]Line two keeps the [E]story going [D]on and on
[F#m]Line three, a [D]little more [A]text here
[E]Line four ends the [A]verse
{end_of_verse}
${v === 3 ? '{column_break}\n' : v === 6 ? '{new_page}\n' : ''}`,
).join('\n')
writeFileSync(
  join(out, 'Long Road Home.cho'),
  `{title: Long Road Home}
{artist: The Placeholders}
{key: A}
{tempo: 120}
{capo: 2}

${verses}
{start_of_chorus}
[D]Long road [E]home, [A]long road [F#m]home
[D]Every [E]mile I [A]walk alone
{end_of_chorus}
`,
)
console.log('samples written to', out)
