// Little pixel characters: a solid block body (painted as background color) with square
// eyes, wide arms and walking legs. Claude is a wide block on four legs; Gemini a narrower
// one on two legs with a star. Four lines: hat, face, arms, legs; then a 3-column side lane
// for the tool the role holds. Every line is exactly SPRITE_WIDTH cells wide.

import type { Mood, Role } from '../types'

export type { Mood, Role }

export const ROLE_LABEL: Record<Role, string> = {
  verification: 'vérification',
  recherche: 'recherche',
  creation: 'création',
  architecte: 'architecte',
  orchestrateur: 'orchestrateur',
  generaliste: 'polyvalent',
}

/** Guess the role from what the agent was asked to do. */
export function roleOf(text: string, hint?: string): Role {
  const h = (hint ?? '').toLowerCase()
  if (h === 'explore') return 'recherche'
  if (h === 'plan') return 'architecte'
  if (/review|verif|check|audit/.test(h)) return 'verification'
  if (h === 'read') return 'recherche'
  if (h === 'code') return 'creation'

  const t = text.toLowerCase()
  if (/orchestr|coordon|dispatch|workflow|pilot/.test(t)) return 'orchestrateur'
  if (/archi|plan|design|conce|conçoi|spec|structur/.test(t)) return 'architecte'
  if (/v[ée]rif|review|relis|relire|relecture|test|check|audit|valid|lint|contr[ôo]l|cas limite/.test(t)) return 'verification'
  if (/cherch|search|explor|\blis\b|\blire\b|read|analys|r[ée]sum|compt|trouv|investig|survey/.test(t)) return 'recherche'
  if (/cr[ée]|[ée]cri|write|impl[ée]ment|code|g[ée]n[ée]r|build|ajout|fix|corrig|propos|jsdoc|r[ée]dig/.test(t)) return 'creation'
  return 'generaliste'
}

/** One run of text with its colors; `bg` paints the cell, which is how the body is solid. */
export type Span = { t: string; fg?: string; bg?: string; bold?: boolean }
export type Line = Span[]

const BODY_W = 11
const SIDE_W = 3
export const SPRITE_WIDTH = BODY_W + SIDE_W
export const SPRITE_LINES = 4

const EYE = '#141414'
const INK = {
  gold: '#f2c14e',
  brown: '#9a6b3f',
  red: '#d94f4f',
  paper: '#efe6c8',
  glass: '#9ec5ff',
  violet: '#c3a6ff',
  spark: '#fff3b0',
  sweat: '#7fc8ff',
}

const width = (line: Line) => line.reduce((n, s) => n + Array.from(s.t).length, 0)
const sp = (t: string, fg?: string, bg?: string, bold?: boolean): Span => ({ t, fg, bg, bold })
const gap = (n: number): Span => ({ t: ' '.repeat(Math.max(0, n)) })

/** Places `hat` (any width up to BODY_W) centred over the body. */
function centred(spans: Span[], w = BODY_W): Line {
  const n = width(spans)
  const left = Math.floor((w - n) / 2)
  return [gap(left), ...spans, gap(w - n - left)]
}

// ---- faces ---------------------------------------------------------------------------

type Face = { l: string; r: string; shift: -1 | 0 | 1; mouth?: string }

function face(mood: Mood, frame: number): Face {
  if (mood === 'error') return { l: 'x', r: 'x', shift: 0, mouth: '~' }
  if (mood === 'happy') {
    // Squint like the little cube: > <, with a grin now and then.
    return Math.floor(frame / 4) % 2 === 0 ? { l: '>', r: '<', shift: 0 } : { l: '^', r: '^', shift: 0, mouth: '‿' }
  }
  if (mood === 'rest') return { l: '▁', r: '▁', shift: 0 }
  // Busy: look around, blink, focus up, chatter.
  // A half block is a square pixel: the eyes sit in the lower half, with body above them.
  const cycle: Face[] = [
    { l: '▄', r: '▄', shift: 0 },
    { l: '▄', r: '▄', shift: 0, mouth: '▁' },
    { l: '▄', r: '▄', shift: -1 },
    { l: '▄', r: '▄', shift: -1 },
    { l: '▄', r: '▄', shift: 0 },
    { l: '▁', r: '▁', shift: 0 },
    { l: '▄', r: '▄', shift: 1 },
    { l: '▀', r: '▀', shift: 0, mouth: '▁' },
  ]
  return cycle[Math.floor(frame / 3) % cycle.length] ?? { l: '▄', r: '▄', shift: 0 }
}

/** The face row of a body `w` wide, eyes `apart` cells apart; glasses for researchers. */
function faceRow(f: Face, w: number, apart: number, body: string, glasses: boolean): Span[] {
  const eyeAt = Math.floor((w - apart - 1) / 2) + f.shift
  const cells: Span[] = []
  for (let i = 0; i < w; i++) {
    const isL = i === eyeAt
    const isR = i === eyeAt + apart
    if (isL || isR) cells.push(sp(isL ? f.l : f.r, EYE, body, true))
    else if (glasses && (i === eyeAt - 1 || i === eyeAt + apart - 1)) cells.push(sp('[', EYE, body))
    else if (glasses && (i === eyeAt + 1 || i === eyeAt + apart + 1)) cells.push(sp(']', EYE, body))
    else if (glasses && i > eyeAt + 1 && i < eyeAt + apart - 1) cells.push(sp('-', EYE, body))
    else cells.push(sp(' ', undefined, body))
  }
  return cells
}

/** Arms stick out of a body `bodyW` wide: thin (top half) out to the full sprite width. */
function armsRow(f: Face, body: string, wave: boolean, bodyW: number, armW: number): Line {
  const mid = Math.floor(BODY_W / 2)
  const bodyFrom = Math.floor((BODY_W - bodyW) / 2)
  const armFrom = Math.floor((BODY_W - armW) / 2)
  const cells: Span[] = []
  for (let i = 0; i < BODY_W; i++) {
    const inBody = i >= bodyFrom && i < bodyFrom + bodyW
    const inArm = i >= armFrom && i < armFrom + armW
    if (inBody && i === mid && f.mouth) cells.push(sp(f.mouth, EYE, body))
    else if (inBody) cells.push(sp(' ', undefined, body))
    // A raised hand: the right arm tip lifts to the lower half for a frame.
    else if (inArm && wave && i === armFrom + armW - 1) cells.push(sp('▄', body))
    else if (inArm) cells.push(sp('▀', body))
    else cells.push(sp(' '))
  }
  return cells
}

// ---- hats ------------------------------------------------------------------------------

function hat(kind: 'claude' | 'gemini', role: Role, mood: Mood, frame: number, body: string): Line {
  const bob = mood === 'busy' && Math.floor(frame / 4) % 2 === 1
  let spans: Span[]
  switch (role) {
    case 'verification': // a detective's deerstalker
      spans = [sp('▄▀▀▀▄', INK.brown), sp('▖', INK.brown)]
      break
    case 'recherche': // a lamp of insight that flickers
      spans = [sp(bob ? '*' : '•', INK.spark, undefined, true)]
      break
    case 'creation': // a painter's beret, tilted
      spans = [sp(' ▄██▄', INK.red), sp('▘', INK.red)]
      break
    case 'architecte': // a hard hat
      spans = [sp('▗▄███▄▖', INK.gold)]
      break
    case 'orchestrateur': // a crown
      spans = [sp('▄▀▄▀▄', INK.gold, undefined, true)]
      break
    default: // an antenna with a blinking light
      spans = [sp(bob ? '╹' : '┃', body)]
  }
  if (kind === 'gemini' && role === 'generaliste') spans = [sp(bob ? '✧' : '✦', INK.spark, undefined, true)]
  else if (kind === 'gemini') spans = [sp(bob ? '✧' : '✦', INK.spark), sp(' '), ...spans]
  return centred(spans)
}

// ---- legs ------------------------------------------------------------------------------

function legsRow(kind: 'claude' | 'gemini', mood: Mood, frame: number, body: string): Line {
  const step = Math.floor(frame / 2) % 4
  if (kind === 'claude') {
    const walk = ['█ █ █ █', '▀ █ ▀ █', '█ █ █ █', '█ ▀ █ ▀']
    const pose = mood === 'busy' ? (walk[step] ?? walk[0]!) : mood === 'rest' ? '▀ ▀ ▀ ▀' : mood === 'happy' && step % 2 === 1 ? '▀ ▀ ▀ ▀' : '█ █ █ █'
    return centred([sp(pose, body)])
  }
  const walk = ['█   █', '▀   █', '█   █', '█   ▀']
  const pose = mood === 'busy' ? (walk[step] ?? walk[0]!) : mood === 'rest' ? '▀   ▀' : mood === 'happy' && step % 2 === 1 ? '▀   ▀' : '█   █'
  return centred([sp(pose, body)])
}

// ---- the tool in the side lane ---------------------------------------------------------

type Lane = [string, string, string, string]

function side(role: Role, mood: Mood, frame: number): { lane: Lane; color: string } {
  const f = Math.floor(frame / 2) % 4
  if (mood === 'error') return { lane: [' ! ', " '", '   ', '   '], color: INK.red }
  if (mood === 'happy') {
    const twinkle: Lane[] = [
      [' * ', '  ✦', '   ', '   '],
      ['  ✦', ' * ', '   ', '   '],
      [' ✦ ', '   ', '  *', '   '],
      ['   ', ' ✦ ', '   ', ' * '],
    ]
    return { lane: twinkle[f] ?? twinkle[0]!, color: INK.spark }
  }
  if (mood === 'rest') {
    const z: Lane[] = [
      ['   ', '   ', ' z ', '   '],
      ['   ', '  z', '   ', '   '],
      ['  Z', '   ', '   ', '   '],
      ['   ', '   ', '   ', '   '],
    ]
    return { lane: z[Math.floor(frame / 4) % 4] ?? z[0]!, color: INK.glass }
  }
  const frames: Record<Role, { lanes: Lane[]; color: string }> = {
    verification: {
      // a magnifying glass sweeping up and down
      lanes: [
        ['(o)', '/  ', '   ', '   '],
        ['   ', '(o)', '/  ', '   '],
        ['   ', '   ', '(o)', '/  '],
        ['   ', '(o)', '/  ', '   '],
      ],
      color: INK.glass,
    },
    recherche: {
      // a book whose pages turn
      lanes: [
        [' ? ', '[=]', '   ', '   '],
        ['  ?', '[/]', '   ', '   '],
        [' ? ', '[|]', '   ', '   '],
        ['?  ', '[\\]', '   ', '   '],
      ],
      color: INK.paper,
    },
    creation: {
      // a pencil scribbling with sparks
      lanes: [
        [' ✎ ', '   ', '.  ', '   '],
        [' ✎ ', ' * ', '.. ', '   '],
        ['  ✎', '   ', '...', '   '],
        [' ✎ ', '  *', '.:.', '   '],
      ],
      color: INK.gold,
    },
    architecte: {
      // a set square being turned
      lanes: [
        [' /|', '/_|', '   ', '   '],
        ['|\\ ', '|_\\', '   ', '   '],
        ['/\\ ', '--', '   ', '   '],
        [' /|', '/_|', '   ', '   '],
      ],
      color: INK.gold,
    },
    orchestrateur: {
      // a baton beating time, notes rising
      lanes: [
        ['  ♪', ' / ', '   ', '   '],
        [' ♪ ', '  \\', '   ', '   '],
        ['♫  ', ' / ', '   ', '   '],
        ['  ♫', '  \\', '   ', '   '],
      ],
      color: INK.violet,
    },
    generaliste: {
      // a cog turning
      lanes: [
        ['   ', ' + ', '   ', '   '],
        ['   ', ' x ', '   ', '   '],
        ['   ', ' + ', '   ', '   '],
        ['   ', ' * ', '   ', '   '],
      ],
      color: INK.spark,
    },
  }
  const pick = frames[role]
  return { lane: pick.lanes[f] ?? pick.lanes[0]!, color: pick.color }
}

const lanePad = (s: string) => {
  const n = Array.from(s).length
  return n >= SIDE_W ? Array.from(s).slice(0, SIDE_W).join('') : s + ' '.repeat(SIDE_W - n)
}

/** The character as four lines of colored spans. `body` is the model's color. */
export function sprite(kind: 'claude' | 'gemini', role: Role, mood: Mood, frame: number, body: string): Line[] {
  const f = face(mood, frame)
  const wave = mood === 'happy' && Math.floor(frame / 3) % 2 === 0
  const glasses = role === 'recherche' && mood !== 'rest'

  const faceSpans =
    kind === 'claude'
      ? centred(faceRow(f, 7, 4, body, glasses))
      : centred(faceRow(f, 5, 2, body, glasses && false))

  const body4: Line[] = [
    hat(kind, role, mood, frame, body),
    faceSpans,
    kind === 'claude' ? armsRow(f, body, wave, 7, 11) : armsRow(f, body, wave, 5, 9),
    legsRow(kind, mood, frame, body),
  ]

  const { lane, color } = side(role, mood, frame)
  return body4.map((line, i) => [...line, sp(lanePad(lane[i] ?? ''), color)])
}

/** Plain text of a sprite line, for tests and previews. */
export const plain = (line: Line) => line.map(s => s.t).join('')

// ---- SVG: the same sprite, pixel-exact, for surfaces whose text lines don't touch ------

/** One cell is 2×2 pixels; a cell is 8×16 CSS pixels, as a terminal cell is 1:2. */
const PX_W = 4
const PX_H = 8
/** Which of a cell's quarters (top-left, top-right, bottom-left, bottom-right) a block glyph fills. */
const QUARTERS: Record<string, [boolean, boolean, boolean, boolean]> = {
  '█': [true, true, true, true],
  '▀': [true, true, false, false],
  '▄': [false, false, true, true],
  '▌': [true, false, true, false],
  '▐': [false, true, false, true],
  '▖': [false, false, true, false],
  '▗': [false, false, false, true],
  '▘': [true, false, false, false],
  '▝': [false, true, false, false],
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** One frame as SVG elements: a pixel grid merged into horizontal runs, then glyphs on top. */
function frameSvg(lines: Line[]): string {
  const cols = SPRITE_WIDTH * 2
  const rows = lines.length * 2
  const grid: (string | undefined)[][] = Array.from({ length: rows }, () => Array<string | undefined>(cols).fill(undefined))
  const glyphs: string[] = []
  lines.forEach((line, li) => {
    let ci = 0
    for (const span of line) {
      for (const ch of Array.from(span.t)) {
        const q = QUARTERS[ch]
        const paint = (dx: number, dy: number, color: string | undefined) => {
          if (color) grid[li * 2 + dy]![ci * 2 + dx] = color
        }
        for (let k = 0; k < 4; k++) paint(k % 2, k < 2 ? 0 : 1, span.bg)
        if (q) {
          q.forEach((on, k) => on && paint(k % 2, k < 2 ? 0 : 1, span.fg ?? '#dddddd'))
        } else if (ch === '▁') {
          glyphs.push(`<rect x="${ci * 8}" y="${li * 16 + 13}" width="8" height="3" fill="${span.fg ?? '#dddddd'}"/>`)
        } else if (ch !== ' ') {
          glyphs.push(
            `<text x="${ci * 8 + 4}" y="${li * 16 + 12}"${span.bold ? ' font-weight="700"' : ''} fill="${span.fg ?? '#dddddd'}">${xml(ch)}</text>`,
          )
        }
        ci++
      }
    }
  })
  const rects: string[] = []
  grid.forEach((row, y) => {
    let x = 0
    while (x < cols) {
      const c = row[x]
      if (!c) {
        x++
        continue
      }
      let end = x + 1
      while (end < cols && row[end] === c) end++
      rects.push(`<rect x="${x * PX_W}" y="${y * PX_H}" width="${(end - x) * PX_W}" height="${PX_H}" fill="${c}"/>`)
      x = end
    }
  })
  return rects.join('') + glyphs.join('')
}

/** Frames one loop of the animation holds, and how long each shows (the ticker's pace). */
export const LOOP_FRAMES = 24
export const FRAME_SECONDS = 0.12

/** The markup of `count` frames of a loop, taking every `step`-th animation frame. */
export function spriteFrames(kind: 'claude' | 'gemini', role: Role, mood: Mood, body: string, count = LOOP_FRAMES, step = 1): string[] {
  const frames: string[] = []
  for (let i = 0; i < count; i++) frames.push(frameSvg(sprite(kind, role, mood, i * step, body)))
  return frames
}

/**
 * Elements that show `frames` in turn, `seconds` each, forever, starting `phase` seconds
 * into the loop. `ref` turns a frame's markup into what to draw (inline, or a <use>).
 */
export function cycle(frames: string[], seconds: number, phase = 0, ref: (markup: string) => string = m => m): string {
  const distinct = [...new Set(frames)]
  if (distinct.length === 1) return `<g>${ref(distinct[0]!)}</g>`
  const total = frames.length * seconds
  const dur = total.toFixed(2)
  // The phase wraps into one loop: a begin earlier than a whole loop is the same point of it.
  const p = Number((((phase % total) + total) % total).toFixed(2))
  const begin = p > 0 && p < Number(dur) ? ` begin="${(-p).toFixed(2)}s"` : ''
  return distinct
    .map(markup => {
      const values = frames.map(m => (m === markup ? 'visible' : 'hidden')).join(';')
      return `<g visibility="hidden"><animate attributeName="visibility" values="${values}" dur="${dur}s"${begin} calcMode="discrete" repeatCount="indefinite"/>${ref(markup)}</g>`
    })
    .join('')
}

export const SVG_TEXT_STYLE =
  "text{font-family:Consolas,'Cascadia Mono','Segoe UI Symbol',monospace;font-size:13px;text-anchor:middle}"

/**
 * The character as one SVG that animates by itself: every distinct frame of a loop, each
 * shown on its own beats with a discrete SMIL animation. It depends only on its arguments,
 * so it is rebuilt (and redrawn) only when the mood, role or color changes.
 */
export function spriteSvg(kind: 'claude' | 'gemini', role: Role, mood: Mood, body: string): string {
  const w = SPRITE_WIDTH * 8
  const h = SPRITE_LINES * 16
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" shape-rendering="crispEdges">` +
    `<style>${SVG_TEXT_STYLE}</style>` +
    cycle(spriteFrames(kind, role, mood, body), FRAME_SECONDS) +
    `</svg>`
  )
}
