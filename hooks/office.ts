// The office view: every agent at a desk, the lead at its own desk on the left. A new agent
// gets a desk that drops in with sparkles, walks in through the door to sit, and the lead
// walks over to hand it its task title, then goes back. An agent done for a while packs a box
// and walks out. One SVG, animated with SMIL.
//
// Time: the SVG's clock starts when the surface loads it. Every one-off animation is given
// its begin relative to `now`, so a scene rebuilt mid-way resumes where it was. Looping
// animations get a negative begin derived from a stable `epoch`, so a rebuilt scene keeps
// them at the same point of their loop instead of restarting them.

import type { Mood, Role } from '../types'
import { cycle, spriteFrames, SVG_TEXT_STYLE } from './sprites'

export type Desk = {
  id: string
  kind: 'claude' | 'gemini'
  role: Role
  mood: Mood
  /** The model's color, a hex string. */
  color: string
  /** Model name, e.g. "Sonnet" or "Gemini Argon (low)". */
  name: string
  /** What it was asked to do, a few words. */
  label: string
  /** When it arrived, on the same clock as `now`. */
  arrivedAt: number
  /** When it finished, on the same clock as `now`. Absent while it works. */
  endedAt?: number
  /** Its place in the room, given once at arrival (see assignSeat). Absent: placed by arrival order. */
  seat?: number
}

export type Scene = {
  desks: Desk[]
  lead: { mood: Mood; color: string }
  now: number
  /** A stable origin of time, on the same clock as `now`: looping animations are phased from it. */
  epoch: number
  /** Animate arrivals newer than this many ms. */
  freshMs: number
  /** Take every `step`-th animation frame (2 by default). */
  step?: number
  /** The highest seat ever handed out: its desk is drawn even if nobody listed sits there. */
  maxSeat?: number
  /** What each seat last held (role, and the key its small object is picked from), for an empty desk nobody listed sits at. */
  seats?: ({ role: Role; itemKey: string } | null)[]
}

const COLS = 4
const SLOT_W = 168
const SLOT_H = 136
const LEFT = 236
const TOP = 92
const DOOR_W = 46
/** The SVG limit a surface takes, with room to spare. */
export const SVG_BUDGET = 125_000
/** A loop of 24 animation frames, sampled every `step` frames: fewer frames, smaller SVG. */
const LOOP = 24
const BASE_S = 0.12
/** A finished agent stays this long at its desk, then packs up... */
export const LEAVE_AFTER_MS = 20_000
/** ...and takes this long to walk out and fade; after that it is no longer drawn. */
export const LEAVE_ANIM_MS = 4_000

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const cut = (s: string, n: number) => (Array.from(s).length > n ? Array.from(s).slice(0, n - 1).join('') + '…' : s)
/** Cells a character takes in a monospace line: wide ones (CJK, emoji) take two. */
const cells = (ch: string): number => {
  const c = ch.codePointAt(0) ?? 0
  const wide =
    (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd)
  return wide ? 2 : 1
}
/** The text cut with an ellipsis to fit n cells. */
function cutCells(s: string, n: number): string {
  const chars = Array.from(s)
  if (chars.reduce((a, c) => a + cells(c), 0) <= n) return s
  let out = ''
  let used = 0
  for (const c of chars) {
    if (used + cells(c) > n - 1) break
    out += c
    used += cells(c)
  }
  return out + '…'
}
const sec = (ms: number) => (ms / 1000).toFixed(2)
const rect = (x: number, y: number, w: number, h: number, fill: string) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`

/** Happy (just finished) looks like rest in the office: fewer reasons to rebuild the scene. */
const calm = (m: Mood): Mood => (m === 'happy' ? 'rest' : m)

type Leave = 'stay' | 'leaving' | 'gone'
/** A desk that finished leaves after LEAVE_AFTER_MS; a busy one, or one with no known end, never. */
function leaveState(d: Desk, now: number): Leave {
  if (d.endedAt == null || d.mood === 'busy') return 'stay'
  const since = now - d.endedAt - LEAVE_AFTER_MS
  return since < 0 ? 'stay' : since < LEAVE_ANIM_MS ? 'leaving' : 'gone'
}

/** Whether an agent walks out some day: it finished, and was not working at the end. */
const departs = (d: Desk) => d.endedAt != null && d.mood !== 'busy'

/**
 * What decides how the scene looks, as a string: equal keys mean the same picture, so the
 * caller rebuilds only when it changes. Time does not: the arrival, the lead's round and a
 * departure are all planned in the scene when they become known, and play out by themselves.
 * A desk arriving, leaving the list or renamed, an agent starting or stopping work, an error,
 * the lead going busy: those change it.
 */
export function officeKey(desks: Desk[], leadMood: Mood, _now: number, _freshMs: number): string {
  const rows = desks.map(d => [d.id, d.kind, d.role, d.color, d.name, d.label, d.arrivedAt, calm(d.mood), d.seat ?? null, departs(d) ? 1 : 0])
  return JSON.stringify([rows, calm(leadMood)])
}

export function sceneSize(count: number): { w: number; h: number } {
  const rows = Math.max(1, Math.ceil(count / COLS))
  return { w: LEFT + COLS * SLOT_W + DOOR_W + 16, h: Math.max(300, TOP + rows * SLOT_H + 24) }
}

function slot(i: number) {
  return { x: LEFT + (i % COLS) * SLOT_W, y: TOP + Math.floor(i / COLS) * SLOT_H }
}

/** FNV-1a: a stable number from an id, to pick a desk's small object. */
function hash(s: string): number {
  let h = 2166136261
  for (const c of s) h = Math.imul(h ^ (c.codePointAt(0) ?? 0), 16777619)
  return h >>> 0
}

// ---- decor ---------------------------------------------------------------------------------
// Repeated pieces (one per role, one per object) are defined once in <defs> and drawn with
// <use>, at the desk's origin: the cost of a decorated desk is a few dozen bytes.

/** What each role keeps on its desk, in desk-local coordinates (the desk top is at y=46). */
const ROLE_DECO: Record<Role, string> = {
  // magnifier and case files
  verification:
    rect(8, 40, 26, 6, '#d6a24a') + rect(8, 40, 8, 2, '#b8862e') + rect(10, 35, 22, 5, '#7fb069') + rect(10, 35, 7, 2, '#5c9e5a') + rect(10, 39, 22, 1, '#efe6c8') +
    rect(40, 30, 12, 12, '#3b3631') + rect(42, 32, 8, 8, '#bfe3f0') + rect(43, 33, 2, 2, '#ffffff') + rect(50, 40, 3, 3, '#3b3631') + rect(53, 43, 3, 3, '#3b3631'),
  // a pile of books
  recherche:
    rect(10, 40, 32, 6, '#5b8fc7') + rect(12, 42, 28, 1, '#efe6c8') + rect(12, 34, 27, 6, '#d94f4f') + rect(14, 36, 23, 1, '#efe6c8') +
    rect(9, 28, 28, 6, '#7fb069') + rect(11, 30, 24, 1, '#efe6c8') + rect(16, 24, 12, 4, '#f2c14e'),
  // a pencil pot and a sketch pad
  creation:
    rect(10, 34, 14, 12, '#9a6b3f') + rect(10, 38, 14, 2, '#7d5636') + rect(12, 24, 2, 10, '#f2c14e') + rect(16, 21, 2, 13, '#d94f4f') +
    rect(20, 26, 2, 8, '#5b8fc7') + rect(12, 22, 2, 2, '#e8c39e') + rect(16, 19, 2, 2, '#e8c39e') + rect(30, 42, 22, 4, '#efe6c8') + rect(30, 45, 22, 1, '#9a8b7a') +
    rect(34, 40, 12, 2, '#d97757'),
  // rolled blueprints
  architecte:
    rect(8, 36, 34, 6, '#5b8fc7') + rect(8, 36, 3, 6, '#cfe0f2') + rect(12, 41, 34, 5, '#4a78b0') + rect(12, 41, 3, 5, '#cfe0f2') + rect(20, 36, 2, 6, '#efe6c8') +
    rect(46, 22, 7, 24, '#5b8fc7') + rect(46, 22, 7, 3, '#cfe0f2') + rect(46, 31, 7, 2, '#efe6c8'),
  // a metronome and a sheet of music
  orchestrateur:
    rect(10, 28, 14, 18, '#7d5636') + rect(13, 24, 8, 4, '#7d5636') + rect(10, 44, 14, 2, '#6e4a2c') + rect(16, 20, 2, 16, '#efe6c8') + rect(14, 24, 6, 3, '#f2c14e') +
    rect(31, 30, 20, 16, '#efe6c8') + [34, 37, 40, 43].map(y => rect(33, y, 16, 1, '#333333')).join('') + rect(36, 36, 3, 2, '#2a2420') + rect(42, 39, 3, 2, '#2a2420') + rect(38, 33, 3, 2, '#2a2420'),
  // a mug and a notepad
  generaliste:
    rect(10, 34, 12, 12, '#d97757') + rect(11, 35, 10, 2, '#3a2414') + rect(22, 36, 4, 2, '#d97757') + rect(24, 38, 2, 5, '#d97757') + rect(22, 41, 4, 2, '#d97757') +
    rect(30, 42, 16, 4, '#efe6c8') + rect(30, 45, 16, 1, '#9a8b7a') + rect(40, 38, 8, 2, '#5b8fc7'),
}

/** A small object on each desk, picked from the desk's id. */
const ITEMS: Record<string, string> = {
  plant: rect(92, 38, 10, 8, '#b5651d') + rect(90, 31, 14, 7, '#5c9e5a') + rect(94, 26, 6, 6, '#7fb069'),
  photo:
    rect(90, 30, 16, 16, '#6b4a30') + rect(92, 32, 12, 12, '#8ec5e8') + rect(96, 36, 4, 4, '#e8c39e') + rect(94, 40, 8, 4, '#d94f4f'),
  duck:
    rect(90, 38, 14, 8, '#f2c14e') + rect(98, 32, 8, 8, '#f2c14e') + rect(106, 36, 4, 3, '#e8803a') + rect(102, 34, 2, 2, '#222222') + rect(92, 40, 6, 3, '#d9a52e'),
  cactus:
    rect(92, 40, 10, 6, '#b5651d') + rect(95, 28, 4, 12, '#4f8f4a') + rect(91, 32, 4, 3, '#4f8f4a') + rect(91, 29, 3, 6, '#4f8f4a') + rect(99, 34, 4, 3, '#4f8f4a') + rect(100, 31, 3, 6, '#4f8f4a'),
  stapler: rect(88, 40, 18, 6, '#d94f4f') + rect(88, 37, 16, 3, '#a73a3a') + rect(90, 38, 2, 1, '#efe6c8'),
}
const ITEM_NAMES = Object.keys(ITEMS)

/** The lead's trophy, on its desk (desk-local, the lead's desk is wider than the others). */
const TROPHY =
  `${rect(158, 43, 14, 3, '#7d5636')}${rect(163, 37, 4, 6, '#f2c14e')}${rect(157, 27, 16, 10, '#f2c14e')}` +
  `${rect(154, 29, 3, 5, '#d9a52e')}${rect(173, 29, 3, 5, '#d9a52e')}${rect(159, 29, 2, 6, '#fff3b0')}`

/** The room: wall, window, clock, door, and the decorations (deco-*). */
function room(w: number, h: number, loopAt: (dur: number, offset?: number) => string): string {
  const doorX = w - DOOR_W - 8
  const boards = Array.from({ length: Math.ceil((h - 70) / 22) }, (_, i) => `<rect x="0" y="${70 + i * 22}" width="${w}" height="1" fill="#2f2924"/>`).join('')
  /** Books standing on a shelf, left to right, resting on `floor`. */
  const books = (x: number, floor: number, specs: [number, number, string][]) => {
    let cx = x
    return specs
      .map(([bw, bh, c]) => {
        const r = rect(cx, floor - bh, bw, bh, c)
        cx += bw + 1
        return r
      })
      .join('')
  }
  const y0 = h - 62 // the coffee table's top
  /** A puff of steam: drifts up and fades, forever. */
  const puff = (x: number, dur: number, offset: number) =>
    `<g opacity="0"><animateTransform attributeName="transform" type="translate" values="0,0;3,-14" dur="${dur}s" repeatCount="indefinite"${loopAt(dur, offset)}/>` +
    `<animate attributeName="opacity" values="0;0.8;0" dur="${dur}s" repeatCount="indefinite"${loopAt(dur, offset)}/>${rect(x, y0 - 48, 4, 4, '#efe6c8')}</g>`
  return [
    `<rect width="${w}" height="${h}" fill="#26211d"/>`,
    boards,
    `<rect width="${w}" height="66" fill="#3a332c"/>`,
    `<rect y="62" width="${w}" height="6" fill="#4a4037"/>`,
    // window with a slow cloud
    `<rect x="${w / 2 - 70}" y="10" width="140" height="42" fill="#5b8fc7"/>`,
    `<g><animateTransform attributeName="transform" type="translate" values="-60,0;60,0;-60,0" dur="40s" repeatCount="indefinite"${loopAt(40)}/><rect x="${w / 2 - 20}" y="20" width="26" height="8" fill="#e8f1fb"/><rect x="${w / 2 - 14}" y="15" width="14" height="6" fill="#e8f1fb"/></g>`,
    `<rect x="${w / 2 - 72}" y="8" width="144" height="4" fill="#4a4037"/><rect x="${w / 2 - 72}" y="50" width="144" height="4" fill="#4a4037"/><rect x="${w / 2 - 2}" y="10" width="4" height="42" fill="#4a4037"/>`,
    // clock with a ticking hand
    `<circle cx="${w / 2 + 130}" cy="32" r="16" fill="#efe6c8" stroke="#4a4037" stroke-width="3"/>`,
    `<line x1="${w / 2 + 130}" y1="32" x2="${w / 2 + 130}" y2="21" stroke="#333" stroke-width="2"><animateTransform attributeName="transform" type="rotate" from="0 ${w / 2 + 130} 32" to="360 ${w / 2 + 130} 32" dur="60s" repeatCount="indefinite"${loopAt(60)}/></line>`,
    // title plate
    `<rect x="16" y="14" width="150" height="30" fill="#2a2420" stroke="#d97757" stroke-width="2"/>`,
    `<text x="91" y="34" fill="#d97757" font-weight="700" style="font-size:15px">BUREAU</text>`,
    // plant
    `<rect x="${w / 2 - 120}" y="40" width="18" height="22" fill="#9a6b3f"/><rect x="${w / 2 - 126}" y="26" width="30" height="16" fill="#5c9e5a"/><rect x="${w / 2 - 118}" y="18" width="14" height="10" fill="#7fb069"/>`,
    // bookshelf
    `<g id="deco-shelf">${rect(196, 12, 112, 46, '#4a3526')}${rect(199, 15, 106, 17, '#2a2018')}${rect(199, 35, 106, 19, '#2a2018')}` +
      books(201, 32, [[6, 14, '#d94f4f'], [5, 11, '#5b8fc7'], [7, 15, '#f2c14e'], [5, 12, '#7fb069'], [6, 13, '#c76b98'], [5, 10, '#efe6c8'], [7, 14, '#d97757'], [5, 12, '#2bb3c0'], [6, 11, '#9b72f2'], [5, 13, '#e0a84e'], [6, 14, '#5b8fc7'], [5, 10, '#d94f4f']]) +
      books(201, 54, [[7, 16, '#2bb3c0'], [5, 13, '#d97757'], [6, 15, '#efe6c8'], [5, 11, '#9b72f2'], [8, 16, '#5c9e5a']]) +
      rect(262, 44, 12, 10, '#b5651d') + rect(264, 36, 8, 8, '#7fb069') + `</g>`,
    // cork board with post-its
    `<g id="deco-board">${rect(660, 10, 100, 46, '#6b4a30')}${rect(663, 13, 94, 40, '#b98b57')}` +
      rect(670, 18, 22, 20, '#f2c14e') + rect(698, 22, 22, 18, '#e58aa8') + rect(728, 16, 22, 22, '#8ec5e8') +
      [24, 28, 32].map(y => rect(673, y, 16, 1, '#9a6b3f')).join('') + [28, 32].map(y => rect(701, y, 16, 1, '#9a6b3f')).join('') + [22, 26, 30].map(y => rect(731, y, 16, 1, '#9a6b3f')).join('') +
      rect(680, 17, 2, 2, '#d94f4f') + rect(708, 21, 2, 2, '#d94f4f') + rect(738, 15, 2, 2, '#d94f4f') + rect(690, 42, 40, 8, '#efe6c8') + rect(694, 45, 30, 1, '#9a8b7a') + `</g>`,
    // poster
    `<g id="deco-poster">${rect(790, 10, 36, 46, '#efe6c8')}${rect(793, 13, 30, 40, '#5b8fc7')}${rect(793, 34, 30, 19, '#5c9e5a')}${rect(793, 30, 16, 6, '#7fb069')}${rect(812, 18, 7, 7, '#f2c14e')}</g>`,
    // standing lamp, with its glow
    `<g id="deco-lamp">${rect(0, 98, 28, 14, '#f2c14e').replace('/>', ' opacity="0.12"/>')}${rect(5, 100, 18, 4, '#d9a52e')}${rect(3, 104, 22, 6, '#f2c14e')}${rect(13, 110, 3, 58, '#4a4037')}${rect(7, 168, 15, 4, '#4a4037')}</g>`,
    // rug
    `<g id="deco-rug">${rect(100, h - 56, 116, 34, '#7a3b2e')}${rect(104, h - 52, 108, 26, '#b5654a')}${rect(110, h - 46, 96, 14, '#e0a84e')}${rect(116, h - 42, 84, 6, '#7a3b2e')}</g>`,
    // coffee machine on a little table, with steam
    `<g id="deco-coffee">${rect(24, y0, 58, 6, '#9a6b3f')}${rect(28, y0 + 6, 5, 34, '#6e4a2c')}${rect(73, y0 + 6, 5, 34, '#6e4a2c')}` +
      rect(32, y0 - 40, 38, 40, '#3b3631') + rect(32, y0 - 40, 38, 6, '#55504a') + rect(38, y0 - 30, 8, 4, '#d94f4f') + rect(50, y0 - 30, 14, 3, '#55504a') +
      rect(42, y0 - 16, 18, 14, '#cfe3ea') + rect(42, y0 - 8, 18, 6, '#5a3a22') + rect(34, y0 - 6, 6, 6, '#d97757') +
      puff(46, 2.4, 0) + puff(54, 3.2, 1.1) + `</g>`,
    // door
    `<rect x="${doorX}" y="22" width="${DOOR_W}" height="${h - 30}" fill="#5a3e28"/>`,
    `<rect x="${doorX + 4}" y="26" width="${DOOR_W - 8}" height="${h - 38}" fill="#6b4a30"/>`,
    `<rect x="${doorX + 8}" y="${22 + (h - 30) / 2}" width="6" height="6" fill="#f2c14e"/>`,
    `<text x="${doorX + DOOR_W / 2}" y="18" fill="#9a8b7a" style="font-size:10px">entrée</text>`,
  ].join('')
}

/** A desk in front of a seat at (x, y): top, front, legs, a monitor whose screen tells the mood. */
function desk(x: number, y: number, mood: Mood, color: string, loopAt: (dur: number) => string, wide = false): string {
  const dw = wide ? 190 : 150
  const screen =
    mood === 'busy'
      ? // scrolling code
        `<rect x="${x + 115}" y="${y + 19}" width="28" height="18" fill="#10161f"/>` +
        `<g><animateTransform attributeName="transform" type="translate" values="0,0;0,-6" dur="0.9s" repeatCount="indefinite"${loopAt(0.9)}/>` +
        [0, 1, 2, 3].map(i => `<rect x="${x + 118}" y="${y + 22 + i * 4}" width="${[16, 22, 12, 19][i]}" height="2" fill="${color}"/>`).join('') +
        `</g>`
      : mood === 'error'
        ? `<rect x="${x + 115}" y="${y + 19}" width="28" height="18" fill="#3a1414"/><text x="${x + 129}" y="${y + 33}" fill="#ff6b6b" font-weight="700">!</text>`
        : `<rect x="${x + 115}" y="${y + 19}" width="28" height="18" fill="#0b0b0b"/>`
  return [
    `<rect x="${x + 112}" y="${y + 16}" width="34" height="24" fill="#2a2a2a"/>`,
    screen,
    `<rect x="${x + 126}" y="${y + 40}" width="6" height="6" fill="#2a2a2a"/>`,
    `<rect x="${x}" y="${y + 46}" width="${dw}" height="8" fill="#9a6b3f"/>`,
    `<rect x="${x + 4}" y="${y + 54}" width="${dw - 8}" height="24" fill="#6e4a2c"/>`,
    `<rect x="${x + 8}" y="${y + 58}" width="${dw - 16}" height="2" fill="#7d5636"/>`,
  ].join('')
}

/** A task sheet lying on the desk. */
const paper = (x: number, y: number) =>
  `<rect x="${x + 64}" y="${y + 38}" width="16" height="9" fill="#efe6c8"/><rect x="${x + 66}" y="${y + 41}" width="11" height="1" fill="#9a8b7a"/><rect x="${x + 66}" y="${y + 43}" width="8" height="1" fill="#9a8b7a"/>`

/** The box an agent carries out when it leaves. */
const carton = (x: number, y: number) =>
  rect(x, y, 22, 18, '#c9a06a') + rect(x, y, 22, 4, '#b08850') + rect(x + 9, y, 4, 18, '#e8d7b0') + rect(x, y + 17, 22, 1, '#8a6a3a')

/**
 * The smallest seat free for an agent arriving at `arrivedAt`, else one after the highest. A
 * seat is free if no listed desk holds it (its run left the history: an empty desk), or if every
 * agent that sat there finished and had walked out entirely before this arrival. Desks without
 * a seat are not counted.
 */
export function assignSeat(desks: Pick<Desk, 'seat' | 'mood' | 'endedAt'>[], arrivedAt: number): number {
  const bySeat = new Map<number, Pick<Desk, 'seat' | 'mood' | 'endedAt'>[]>()
  let max = -1
  for (const d of desks) {
    if (d.seat == null) continue
    bySeat.set(d.seat, [...(bySeat.get(d.seat) ?? []), d])
    max = Math.max(max, d.seat)
  }
  for (let s = 0; s <= max; s++) {
    const held = bySeat.get(s)
    if (!held || held.every(d => d.endedAt != null && d.mood !== 'busy' && arrivedAt >= d.endedAt + LEAVE_AFTER_MS + LEAVE_ANIM_MS)) return s
  }
  return max + 1
}

/** A seat's agent now (or last), and whether it took over a desk that already existed. */
type Entry = { desk: Desk; seat: number; recycled: boolean }
type Layout = { entries: Entry[]; count: number; placed: Desk[] }

/**
 * Who sits where, from the data alone: a desk keeps the seat it was given at arrival; one with
 * no seat gets what assignSeat would have given it, desks taken in order of arrival. A seat
 * shows its latest agent. `count` is the number of seats drawn (an empty desk on each seat
 * nobody holds, up to the highest).
 */
function layout(desks: Desk[], maxSeat = -1): Layout {
  const order = desks.map((d, i) => ({ d, i })).sort((a, b) => a.d.arrivedAt - b.d.arrivedAt || a.i - b.i)
  const placed: Desk[] = []
  const last = new Map<number, Entry>()
  let max = -1
  for (const { d } of order) {
    const seat = d.seat ?? assignSeat(placed, d.arrivedAt)
    const seated = { ...d, seat }
    placed.push(seated)
    // A seat at or below one already handed out is a desk that stood there before: no drop.
    last.set(seat, { desk: seated, seat, recycled: seat <= max })
    max = Math.max(max, seat)
  }
  return { entries: [...last.values()].sort((a, b) => a.seat - b.seat), count: Math.max(max, maxSeat) + 1, placed }
}

const HOME = { x: 28, y: TOP }
const ROLE_ORDER: Role[] = ['verification', 'recherche', 'creation', 'architecte', 'orchestrateur', 'generaliste']

/** The lead's round to a burst of newcomers: when each is handed its task, and the lead's path. */
type Tour = { start: number; members: Entry[]; handAt: Map<string, number>; values: string; keyTimes: string; dur: number; end: number; roundEnd: number; lastHand: number }

/**
 * The round, from the arrival times of the burst alone (never from `now`): the lead sets off
 * shortly after the first arrival and visits each newcomer in order. Each stop's pace depends
 * only on its rank, shrinking for later ones, so a later arrival changes nothing already
 * planned, and however many come, every hand-over is well inside the first one's window. A
 * round never starts before the previous one is over (`notBefore`).
 */
function planTour(members: Entry[], notBefore: number): Tour {
  const start = Math.max(members[0]!.desk.arrivedAt + 700, notBefore)
  const pts: { t: number; x: number; y: number }[] = [{ t: 0, x: 0, y: 0 }]
  const handAt = new Map<string, number>()
  let t = start
  let px = 0
  let py = 0
  let g = 1
  members.forEach((m, k) => {
    g = k < 2 ? 1 : 0.65 ** (k - 1)
    const { x, y } = slot(m.seat)
    const tx = x - 58 - HOME.x
    const ty = y + 34 - HOME.y
    const walk = Math.max(150, Math.min(1200, Math.max(500, (Math.hypot(tx - px, ty - py) / 260) * 1000)) * g)
    const arrive = Math.round(Math.max(t + walk, m.desk.arrivedAt + 900)) // not before it is there
    // However hurried, a stop lasts 250 ms at least.
    const pause = Math.round(Math.max(250, 600 * g))
    pts.push({ t: arrive - start, x: tx, y: ty })
    handAt.set(m.desk.id, arrive + Math.round(pause * 0.4))
    t = arrive + pause
    pts.push({ t: t - start, x: tx, y: ty })
    px = tx
    py = ty
  })
  t += Math.round(Math.max(150, Math.min(1200, Math.max(500, (Math.hypot(px, py) / 260) * 1000)) * g))
  pts.push({ t: t - start, x: 0, y: 0 })
  const dur = t - start
  const lastHand = Math.max(...handAt.values())
  return {
    start,
    members,
    handAt,
    values: pts.map(p => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(';'),
    keyTimes: pts.map(p => (p.t / dur).toFixed(4)).join(';'),
    dur,
    end: Math.max(t, lastHand + 2200), // the round, and the last bubble (it starts 200 ms before the hand-over, lasts 2.4 s)
    roundEnd: t,
    lastHand,
  }
}

export function officeSvg(scene: Scene): string {
  return render(scene, layout(scene.desks, scene.maxSeat)).svg
}

function render(scene: Scene, lay: Layout): { svg: string; settleAt: number } {
  const { lead, now, epoch, freshMs } = scene
  const leadMood = calm(lead.mood)
  const step = scene.step ?? 2
  const FRAMES = Math.max(1, Math.floor(LOOP / step))
  const FRAME_S = BASE_S * step
  const { w, h } = sceneSize(lay.count)
  const doorX = w - DOOR_W - 8

  // Seconds since the epoch: every loop starts that long ago, wrapped into its own duration
  // (so the begin is in ]-dur, 0]). A scene rebuilt later finds each loop where it was.
  const clock = (now - epoch) / 1000
  const loopAt = (dur: number, offset = 0): string => {
    const p = Number(((((clock + offset) % dur) + dur) % dur).toFixed(2))
    return p > 0 && p < dur ? ` begin="${(-p).toFixed(2)}s"` : ''
  }

  // Frames are shared: identical markup is defined once and drawn with <use>.
  const defs = new Map<string, string>()
  const ref = (markup: string) => {
    let id = defs.get(markup)
    if (!id) {
      id = `f${defs.size}`
      defs.set(markup, id)
    }
    return `<use href="#${id}"/>`
  }
  // Decor pieces, defined once under their own id and placed at a desk's origin.
  const pieces = new Map<string, string>()
  const place = (id: string, markup: string, x: number, y: number) => {
    pieces.set(id, markup)
    return `<use href="#${id}" x="${x}" y="${y}"/>`
  }
  /** A desk's role objects and its small object (picked from `key`): they outlast the agent. */
  const deskObjects = (role: Role, key: string, x: number, y: number) => {
    const item = ITEM_NAMES[hash(key) % ITEM_NAMES.length]!
    return place(`desk-deco-${role}`, ROLE_DECO[role], x, y) + place(`desk-item-${item}`, ITEMS[item]!, x, y)
  }
  // The character's loop is always 24 frames of 0.12 s: at `step`, every step-th frame, each longer.
  const character = (kind: 'claude' | 'gemini', role: Role, mood: Mood, color: string, phase: number) =>
    cycle(spriteFrames(kind, role, mood, color, FRAMES, step), FRAME_S, phase + clock, ref)

  // The lead's rounds: bursts of arrivals (within the first one's window), each with its own
  // round. One still running, or with a bubble still to show, stays in the scene, so a rebuild
  // plays the rest exactly where it was; an older agent just sits.
  const eligible = lay.entries
    .filter(e => leaveState(e.desk, now) !== 'gone' && now >= e.desk.arrivedAt)
    .sort((a, b) => a.desk.arrivedAt - b.desk.arrivedAt || a.seat - b.seat)
  const tours: Tour[] = []
  let free = -Infinity // when the lead is back home from the previous round
  for (let k = 0; k < eligible.length; ) {
    const first = eligible[k]!
    const members = [first]
    for (k++; k < eligible.length && eligible[k]!.desk.arrivedAt < first.desk.arrivedAt + freshMs; k++) members.push(eligible[k]!)
    const tour = planTour(members, free)
    free = tour.roundEnd
    if (now < tour.end) tours.push(tour)
  }
  const handAt = new Map<string, number>()
  for (const t of tours) for (const [id, at] of t.handAt) handAt.set(id, at)

  const parts: string[] = [room(w, h, loopAt)]
  /** Departing agents, drawn over the desks (they walk past the others). */
  const walkers: string[] = []
  const bySeat = new Map(lay.entries.map(e => [e.seat, e]))

  /** The task sheet: already there, or laid down as the lead hands it over. */
  const sheet = (d: Desk, x: number, y: number) => {
    const at = handAt.get(d.id)
    return at === undefined ? paper(x, y) : `<g opacity="0"><set attributeName="opacity" to="1" begin="${sec(at - now)}s" fill="freeze"/>${paper(x, y)}</g>`
  }

  // Desks, agents, labels: one per seat up to the highest, empty where nobody sits.
  for (let i = 0; i < lay.count; i++) {
    const { x, y } = slot(i)
    const entry = bySeat.get(i)
    if (!entry) {
      // Nobody listed sits here: the seat table remembers what the last agent left on the desk.
      const kept = scene.seats?.[i]
      const objects = kept ? deskObjects(kept.role, kept.itemKey, x, y) : deskObjects(ROLE_ORDER[i % ROLE_ORDER.length]!, `seat-${i}`, x, y)
      parts.push(`<g class="desk-empty">${desk(x, y, 'rest', '#777777', loopAt)}${objects}</g>`)
      continue
    }
    const d = entry.desk
    const mood = calm(d.mood)
    const state = leaveState(d, now)
    // An agent that walked out: its desk stays, empty and switched off, with its objects.
    if (state === 'gone') {
      parts.push(`<g class="desk-empty">${desk(x, y, 'rest', d.color, loopAt)}${deskObjects(d.role, d.id, x, y)}</g>`)
      continue
    }
    const age = now - d.arrivedAt
    const begin = age >= 0 && age < freshMs ? sec(d.arrivedAt - now) : null
    const phase = (i * 0.37) % (FRAMES * FRAME_S)

    // The agent: seated, or walking in from the door when fresh.
    const agent = `<g transform="translate(${x + 4},${y})">${character(d.kind, d.role, mood, d.color, phase)}</g>`
    let seated = agent
    if (begin !== null) {
      const dx = doorX - (x + 4)
      const dy = h - 90 - y
      seated = `<g><animateTransform attributeName="transform" type="translate" values="${dx},${dy};${dx},${dy};${dx},${0};0,0" keyTimes="0;0.25;0.6;1" dur="1.8s" begin="${begin}s" fill="freeze"/>${agent}</g>`
    }

    const furniture = desk(x, y, mood, d.color, loopAt) + deskObjects(d.role, d.id, x, y)
    const tags =
      `<text x="${x + 75}" y="${y + 96}" fill="${d.color}" font-weight="700" style="font-size:11px">${xml(cut(d.name, 22))}</text>` +
      `<text x="${x + 75}" y="${y + 110}" fill="#a89a8a" style="font-size:10px">${xml(cut(d.label, 26))}</text>`

    if (departs(d)) {
      // Planned as soon as the agent has finished, so the scene needs no rebuild when it goes: at
      // endedAt + LEAVE_AFTER_MS a box appears, the agent carries it along the aisle to the door
      // and fades, and its name tag and sheet fade with it; the desk stays. Every begin is
      // relative to that start (positive while it is still to come).
      const t0 = d.endedAt! + LEAVE_AFTER_MS - now
      const at = (frac: number) => `${sec(t0 + frac * LEAVE_ANIM_MS)}s`
      const span = (frac: number) => `${((frac * LEAVE_ANIM_MS) / 1000).toFixed(2)}s`
      const dx = doorX - (x + 4)
      const dy = h - 90 - y
      const lane = Math.min(56, dy) // step out of the seat, then walk below the desks
      const total = dx + dy
      const keyTimes = [0, lane / total, (lane + dx) / total, 1].map(k => k.toFixed(3)).join(';')
      // The seated agent disappears as its walking copy (drawn over the desks) takes over.
      // Opacity, not visibility: the sprite's frames animate their own visibility to "visible",
      // which overrides a hidden parent, so both copies would show; a parent's opacity can't be undone.
      parts.push(`<g><set attributeName="opacity" to="0" begin="${at(0)}" fill="freeze"/>${seated}</g>`)
      walkers.push(
        `<g opacity="0"><set attributeName="opacity" to="1" begin="${at(0)}" fill="freeze"/>` +
          `<g><animateTransform attributeName="transform" type="translate" values="0,0;0,${lane};${dx},${lane};${dx},${dy}" keyTimes="${keyTimes}" begin="${at(0.12)}" dur="${span(0.7)}" fill="freeze"/>` +
          `<animate attributeName="opacity" from="1" to="0" begin="${at(0.6)}" dur="${span(0.4)}" fill="freeze"/>` +
          `${agent}<g class="carton" opacity="0"><set attributeName="opacity" to="1" begin="${at(0)}" fill="freeze"/>${carton(x + 96, y + 36)}</g></g></g>`,
      )
      parts.push(furniture)
      parts.push(`<g><animate attributeName="opacity" from="1" to="0" begin="${at(0.6)}" dur="${span(0.4)}" fill="freeze"/>${tags}${sheet(d, x, y)}</g>`)
      continue
    }
    parts.push(seated)

    // The desk: drops from above with sparkles when fresh and new. An agent taking over a desk
    // that already stands there just walks in (above) and is handed its task.
    if (begin !== null && !entry.recycled) {
      parts.push(
        `<g opacity="0"><set attributeName="opacity" to="1" begin="${begin}s" fill="freeze"/>` +
          `<animateTransform attributeName="transform" type="translate" values="0,-70;0,6;0,-3;0,0" keyTimes="0;0.6;0.8;1" dur="0.6s" begin="${begin}s" fill="freeze"/>${furniture}</g>`,
      )
      const sparks = [
        [-30, -20],
        [30, -24],
        [-36, 10],
        [38, 8],
        [0, -34],
      ]
      parts.push(
        sparks
          .map(
            ([sx, sy]) =>
              `<text x="${x + 75}" y="${y + 50}" fill="#fff3b0" opacity="0"><animate attributeName="opacity" values="0;1;0" dur="0.9s" begin="${(Number(begin) + 0.45).toFixed(2)}s" fill="freeze"/><animateTransform attributeName="transform" type="translate" values="0,0;${sx},${sy}" dur="0.9s" begin="${(Number(begin) + 0.45).toFixed(2)}s" fill="freeze"/>✦</text>`,
          )
          .join(''),
      )
    } else parts.push(furniture)

    // Name tag.
    parts.push(tags)
  }

  // Task sheets (on desks whose agent stays) and the title bubbles of the round's newcomers.
  for (const { desk: d, seat } of lay.entries) {
    if (leaveState(d, now) === 'gone') continue
    const { x, y } = slot(seat)
    if (!departs(d)) parts.push(sheet(d, x, y))
    const at = handAt.get(d.id)
    if (at === undefined) continue
    // The task title in a bubble over the desk, big enough to read, for a moment.
    const shown = cutCells(d.label, 30)
    const bw = Array.from(shown).reduce((n, c) => n + cells(c), 0) * 9 + 16 // a 15px monospace cell is under 9px wide
    const bh = 24
    const bx = Math.round(Math.max(4, Math.min(w - 4 - bw, x + 75 - bw / 2))) // never out of the scene
    const by = y - 30
    const tail = Math.round(Math.max(bx + 6, Math.min(bx + bw - 14, x + 30)))
    parts.push(
      `<g opacity="0"><animate attributeName="opacity" values="1;1;0" keyTimes="0;0.85;1" dur="2.4s" begin="${sec(at - 200 - now)}s" fill="freeze"/>` +
        `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="4" fill="#efe6c8"/><rect x="${tail}" y="${by + bh}" width="8" height="6" fill="#efe6c8"/>` +
        `<text x="${bx + bw / 2}" y="${by + 17}" fill="#2a2420" font-weight="700" style="font-size:15px">${xml(shown)}</text></g>`,
    )
  }

  parts.push(...walkers)

  // The lead, drawn last so it walks in front of the desks; carries a sheet while walking.
  const rounds = tours
    .map(
      t =>
        `<animateTransform attributeName="transform" type="translate" values="${t.values}" keyTimes="${t.keyTimes}" dur="${sec(t.dur)}s" begin="${sec(t.start - now)}s" fill="freeze"/>`,
    )
    .join('')
  const carry = tours
    .map(
      t =>
        `<g opacity="0"><animate attributeName="opacity" values="1;1;0" keyTimes="0;0.9;1" dur="${sec(t.lastHand - t.start)}s" begin="${sec(t.start - now)}s" fill="freeze"/>${paper(56, 6)}</g>`,
    )
    .join('')
  parts.push(
    `<g transform="translate(${HOME.x + 8},${HOME.y})"><g>${rounds}${character('claude', 'orchestrateur', leadMood, lead.color, 0)}${carry}</g></g>`,
  )

  // The lead's desk, its trophy and nameplate, over the lead's legs while it sits.
  parts.push(desk(HOME.x, HOME.y, leadMood, lead.color, loopAt, true))
  parts.push(place('lead-deco', TROPHY, HOME.x, HOME.y))
  parts.push(`<rect x="${HOME.x + 50}" y="${HOME.y + 62}" width="92" height="12" fill="#2a2420"/>`)
  parts.push(`<text x="${HOME.x + 96}" y="${HOME.y + 72}" fill="#f2c14e" style="font-size:9px">CHEF DE PROJET</text>`)

  const defsMarkup =
    [...defs].map(([markup, id]) => `<g id="${id}">${markup}</g>`).join('') +
    [...pieces].map(([id, markup]) => `<g id="${id}">${markup}</g>`).join('')
  // When everything the scene still has to play is over: the arrival windows, the rounds with
  // their last bubble, the departures. A scene built after that has nothing planned left.
  let settleAt = -Infinity
  for (const { desk: d } of lay.entries) {
    if (leaveState(d, now) === 'gone') continue
    if (now - d.arrivedAt >= 0 && now - d.arrivedAt < freshMs) settleAt = Math.max(settleAt, d.arrivedAt + freshMs)
    if (departs(d)) settleAt = Math.max(settleAt, d.endedAt! + LEAVE_AFTER_MS + LEAVE_ANIM_MS)
  }
  for (const t of tours) settleAt = Math.max(settleAt, t.end)
  return {
    settleAt: Number.isFinite(settleAt) ? settleAt : now,
    svg:
      // 100%: the scene stretches to whatever frame the surface gives it, keeping its shape.
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" height="100%" preserveAspectRatio="xMidYMin meet" shape-rendering="crispEdges">` +
      `<style>${SVG_TEXT_STYLE}</style><defs>${defsMarkup}</defs>` +
      parts.join('') +
      `</svg>`,
  }
}

/**
 * The office within the SVG budget: fewer frames per loop first (calmer animation), then
 * only the most recent desks (the seats of the others stay, empty). Says how many agents still
 * at work or waiting it left out, how many seats it draws, and `settleAt`: when everything the
 * scene plans (arrivals, rounds, departures) is over, so that a scene built after it plays nothing.
 */
export function officeWithin(scene: Scene): { svg: string; hidden: number; shown: number; settleAt: number } {
  const { placed, count } = layout(scene.desks, scene.maxSeat)
  for (const step of [2, 3, 4, 6, 12, 24]) {
    const r = render({ ...scene, step }, layout(placed, scene.maxSeat))
    if (r.svg.length <= SVG_BUDGET) return { ...r, hidden: 0, shown: count }
  }
  const waiting = (ds: Desk[]) => ds.filter(d => leaveState(d, scene.now) !== 'gone').length
  for (let keep = placed.length - 1; keep >= 1; keep--) {
    const lay = layout(placed.slice(-keep), scene.maxSeat)
    const r = render({ ...scene, step: 24 }, lay)
    if (r.svg.length <= SVG_BUDGET) return { ...r, hidden: waiting(placed) - waiting(placed.slice(-keep)), shown: lay.count }
  }
  const lay = layout([], scene.maxSeat)
  return { ...render({ ...scene, step: 24 }, lay), hidden: waiting(placed), shown: lay.count }
}
