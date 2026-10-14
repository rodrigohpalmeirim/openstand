/**
 * Built-in stamps. Symbols are hand-drawn SVG paths authored for OpenStand (no third-party music
 * fonts); markings like dynamics and "D.S." are text in standard fonts.
 */

export type StampGroup = 'Dynamics' | 'Articulation' | 'Navigation' | 'Fingering' | 'Accidentals' | 'Text' | 'Other'

interface StampBase {
  id: string
  label: string
  group: StampGroup
}

export interface PathStamp extends StampBase {
  kind: 'path'
  /** Design box. */
  w: number
  h: number
  /** Filled paths. */
  fill?: string[]
  /** Stroked paths with a stroke width in design units. */
  stroke?: { d: string; w: number }[]
}

export interface TextStamp extends StampBase {
  kind: 'text'
  text: string
  font: 'dyn' | 'serif' | 'serif-italic' | 'sans-bold'
}

export type Stamp = PathStamp | TextStamp

export const STAMP_FONTS: Record<TextStamp['font'], { family: string; bold: boolean; italic: boolean }> = {
  dyn: { family: "'Times New Roman', Times, Georgia, serif", bold: true, italic: true },
  serif: { family: "'Times New Roman', Times, Georgia, serif", bold: false, italic: false },
  'serif-italic': { family: "'Times New Roman', Times, Georgia, serif", bold: true, italic: true },
  'sans-bold': { family: "'Inter Variable', system-ui, Arial, sans-serif", bold: true, italic: false },
}

const circle = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`

const text = (id: string, t: string, group: StampGroup, font: TextStamp['font'], label = t): TextStamp => ({ id, label, group, kind: 'text', text: t, font })

export const STAMPS: Stamp[] = [
  // Dynamics
  ...['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'sf', 'sfz', 'fp', 'rf'].map((d) => text(d, d, 'Dynamics', 'dyn')),
  text('cresc', 'cresc.', 'Dynamics', 'serif-italic'),
  text('dim', 'dim.', 'Dynamics', 'serif-italic'),

  // Articulation
  {
    id: 'fermata',
    label: 'Fermata',
    group: 'Articulation',
    kind: 'path',
    w: 100,
    h: 60,
    fill: ['M4 56C4 -2 96 -2 96 56L89 56C87 12 13 12 11 56Z', circle(50, 47, 7)],
  },
  { id: 'accent', label: 'Accent', group: 'Articulation', kind: 'path', w: 100, h: 70, stroke: [{ d: 'M10 10L88 35L10 60', w: 9 }] },
  { id: 'marcato', label: 'Marcato', group: 'Articulation', kind: 'path', w: 80, h: 90, fill: ['M40 0L80 90L62 90L40 38L18 90L0 90Z'] },
  { id: 'staccato', label: 'Staccato', group: 'Articulation', kind: 'path', w: 40, h: 40, fill: [circle(20, 20, 14)] },
  { id: 'staccatissimo', label: 'Staccatissimo', group: 'Articulation', kind: 'path', w: 40, h: 100, fill: ['M6 0L34 0L20 96Z'] },
  { id: 'tenuto', label: 'Tenuto', group: 'Articulation', kind: 'path', w: 100, h: 24, stroke: [{ d: 'M6 12L94 12', w: 10 }] },
  {
    id: 'breath',
    label: 'Breath mark',
    group: 'Articulation',
    kind: 'path',
    w: 80,
    h: 90,
    fill: ['M40 7A18 18 0 0 1 58 25C58 52 44 72 20 86L17 81C33 69 40 56 41 43A18 18 0 0 1 40 7Z'],
  },
  { id: 'caesura', label: 'Caesura', group: 'Articulation', kind: 'path', w: 90, h: 100, stroke: [{ d: 'M8 95L42 5M46 95L80 5', w: 10 }] },
  { id: 'upbow', label: 'Up bow', group: 'Articulation', kind: 'path', w: 90, h: 100, stroke: [{ d: 'M8 5L45 95L82 5', w: 8 }] },
  { id: 'downbow', label: 'Down bow', group: 'Articulation', kind: 'path', w: 100, h: 90, fill: ['M4 90L4 4L96 4L96 90L85 90L85 26L15 26L15 90Z'] },
  text('tr', 'tr', 'Articulation', 'serif-italic', 'Trill'),
  text('pizz', 'pizz.', 'Articulation', 'serif-italic'),
  text('arco', 'arco', 'Articulation', 'serif-italic'),
  text('ped', 'Ped.', 'Articulation', 'serif-italic', 'Pedal'),
  {
    id: 'pedup',
    label: 'Pedal release',
    group: 'Articulation',
    kind: 'path',
    w: 100,
    h: 100,
    stroke: [{ d: 'M50 8L50 92M8 50L92 50M20 20L80 80M80 20L20 80', w: 9 }],
    fill: [circle(50, 50, 16)],
  },

  // Navigation
  {
    id: 'segno',
    label: 'Segno',
    group: 'Navigation',
    kind: 'path',
    w: 100,
    h: 100,
    stroke: [
      { d: 'M70 24C62 6 28 8 30 30C32 48 70 46 70 70C70 94 36 94 28 76', w: 9 },
      { d: 'M18 94L82 6', w: 6 },
    ],
    fill: [circle(20, 46, 7), circle(80, 56, 7)],
  },
  {
    id: 'coda',
    label: 'Coda',
    group: 'Navigation',
    kind: 'path',
    w: 100,
    h: 100,
    stroke: [
      { d: 'M22 50a28 36 0 1 0 56 0a28 36 0 1 0 -56 0Z', w: 8 },
      { d: 'M50 0L50 100M4 50L96 50', w: 6 },
    ],
  },
  text('ds', 'D.S.', 'Navigation', 'serif-italic'),
  text('dc', 'D.C.', 'Navigation', 'serif-italic'),
  text('fine', 'Fine', 'Navigation', 'serif-italic'),
  text('tocoda', 'To Coda', 'Navigation', 'serif-italic'),
  text('dsalcoda', 'D.S. al Coda', 'Navigation', 'serif-italic'),
  text('dcalfine', 'D.C. al Fine', 'Navigation', 'serif-italic'),
  text('vs', 'V.S.', 'Navigation', 'serif-italic', 'Turn page (V.S.)'),

  // Fingering
  ...['0', '1', '2', '3', '4', '5'].map((n) => text(`finger${n}`, n, 'Fingering', 'sans-bold')),
  text('fingerT', 'T', 'Fingering', 'sans-bold', 'Thumb'),

  // Accidentals
  {
    id: 'sharp',
    label: 'Sharp',
    group: 'Accidentals',
    kind: 'path',
    w: 80,
    h: 100,
    stroke: [{ d: 'M30 6L30 96M52 0L52 90', w: 6 }],
    fill: ['M12 36L70 24L70 38L12 50Z', 'M12 66L70 54L70 68L12 80Z'],
  },
  {
    id: 'flat',
    label: 'Flat',
    group: 'Accidentals',
    kind: 'path',
    w: 70,
    h: 100,
    stroke: [{ d: 'M18 0L18 96', w: 7 }],
    fill: ['M18 96C46 80 66 66 62 52C58 40 40 42 18 60L18 69C36 55 50 54 50 62C50 72 38 82 18 89Z'],
  },
  {
    id: 'natural',
    label: 'Natural',
    group: 'Accidentals',
    kind: 'path',
    w: 70,
    h: 100,
    stroke: [{ d: 'M16 4L16 74M54 26L54 96', w: 6 }],
    fill: ['M16 32L54 22L54 36L16 46Z', 'M16 66L54 56L54 70L16 80Z'],
  },

  // Text
  text('rit', 'rit.', 'Text', 'serif-italic'),
  text('rall', 'rall.', 'Text', 'serif-italic'),
  text('atempo', 'a tempo', 'Text', 'serif-italic'),
  text('8va', '8va', 'Text', 'serif-italic'),
  text('simile', 'sim.', 'Text', 'serif-italic'),
  text('tacet', 'tacet', 'Text', 'serif-italic'),
  text('solo', 'Solo', 'Text', 'serif-italic'),
  text('tutti', 'Tutti', 'Text', 'serif-italic'),

  // Other
  {
    id: 'glasses',
    label: 'Watch out!',
    group: 'Other',
    kind: 'path',
    w: 110,
    h: 60,
    stroke: [
      { d: `${circle(30, 36, 18)}${circle(80, 36, 18)}M48 33Q55 24 62 33M12 32L4 16M98 32L106 16`, w: 6 },
    ],
  },
  {
    id: 'circle',
    label: 'Circle',
    group: 'Other',
    kind: 'path',
    w: 100,
    h: 80,
    stroke: [{ d: 'M70 8C40 0 6 14 6 40C6 64 32 76 56 74C82 72 96 56 94 38C92 22 78 10 56 8', w: 5 }],
  },
  {
    id: 'pageturn',
    label: 'Turn page',
    group: 'Other',
    kind: 'path',
    w: 100,
    h: 80,
    stroke: [{ d: 'M10 70C10 30 40 16 78 22', w: 8 }],
    fill: ['M70 4L98 24L68 42Z'],
  },
  { id: 'check', label: 'Check', group: 'Other', kind: 'path', w: 100, h: 80, stroke: [{ d: 'M8 42L36 70L92 8', w: 10 }] },
  { id: 'star', label: 'Star', group: 'Other', kind: 'path', w: 100, h: 96, fill: ['M50 0L62 36L100 36L69 58L81 95L50 72L19 95L31 58L0 36L38 36Z'] },
  { id: 'breathV', label: 'Breathe (V)', group: 'Other', kind: 'path', w: 70, h: 70, stroke: [{ d: 'M6 6L35 64L64 6', w: 6 }] },
]

export const STAMP_GROUPS: StampGroup[] = ['Dynamics', 'Articulation', 'Navigation', 'Fingering', 'Accidentals', 'Text', 'Other']

const byId = new Map(STAMPS.map((s) => [s.id, s]))

export function getStamp(id: string): Stamp {
  return byId.get(id) ?? { id, label: id, group: 'Text', kind: 'text', text: id, font: 'serif-italic' }
}
