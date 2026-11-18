// Spec for the office scene: the lead's bubble shows the task title, the scene is rebuilt only
// on a significant change (officeKey), and looping animations resume from a stable epoch.

import { expect, test } from 'claude-code/testing'

import type { Mood } from '../types'
import * as office from './office'
import { officeSvg, officeWithin, sceneSize } from './office'
import { spriteFrames } from './sprites'
import type { Desk, Scene } from './office'

// ---- helpers ---------------------------------------------------------------------------

const NOW = 1_000_000
const FRESH = 10_000

/** A desk; `endedAt` (when it finished) and `seat` (its place, given at arrival) are fields of Desk. */
function mk(id: string, mood: Mood, arrivedAt: number, extra: Partial<Desk> & { endedAt?: number; seat?: number } = {}): SeatedDesk {
  return {
    id,
    kind: 'claude',
    role: 'creation',
    mood,
    color: '#e0a84e',
    name: 'Sonnet',
    label: `Tâche ${id}`,
    arrivedAt,
    ...extra,
  } as SeatedDesk
}

type SeatedDesk = Desk & { seat?: number }

type AssignSeat = (desks: Desk[], arrivedAt: number) => number
/** The seat a desk arriving at `arrivedAt` takes, given the desks already seated. */
function assignSeat(desks: Desk[], arrivedAt: number): number {
  const f = (office as unknown as { assignSeat?: AssignSeat }).assignSeat
  if (typeof f !== 'function') throw new Error('office.ts must export assignSeat(desks, arrivedAt): number')
  return f(desks, arrivedAt)
}

/** A number constant office.ts must export. */
function constant(name: 'LEAVE_AFTER_MS' | 'LEAVE_ANIM_MS'): number {
  const v = (office as unknown as Record<string, unknown>)[name]
  if (typeof v !== 'number') throw new Error(`office.ts must export the number ${name}`)
  return v
}

/** Every id and class token in the SVG. */
function marks(svg: string): string[] {
  const out: string[] = []
  const re = /\b(?:id|class)="([^"]*)"/g
  for (let m = re.exec(svg); m; m = re.exec(svg)) out.push(...(m[1] ?? '').split(/\s+/).filter(Boolean))
  return out
}
const marksWith = (svg: string, prefix: string) => [...new Set(marks(svg).filter(t => t.startsWith(prefix)))]

type SceneIn = Omit<Scene, 'epoch'> & { epoch: number }
/** The scene with its `epoch` (same clock as `now`). */
const svgOf = (s: SceneIn): string => officeSvg(s as unknown as Scene)

type OfficeKey = (desks: Desk[], leadMood: Mood, now: number, freshMs: number) => string
function officeKey(...args: Parameters<OfficeKey>): string {
  const f = (office as unknown as { officeKey?: OfficeKey }).officeKey
  if (typeof f !== 'function') throw new Error('office.ts must export officeKey(desks, leadMood, now, freshMs): string')
  return f(...args)
}

const unxml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

type TextEl = { at: number; attrs: string; raw: string; content: string; size: number }
/** Every <text> element with plain content, and its font size (13px, the stylesheet's, by default). */
function texts(svg: string): TextEl[] {
  const out: TextEl[] = []
  const re = /<text\b([^>]*)>([^<]*)<\/text>/g
  for (let m = re.exec(svg); m; m = re.exec(svg)) {
    const attrs = m[1] ?? ''
    const size = /font-size:\s*([\d.]+)px/.exec(attrs)?.[1] ?? /font-size="([\d.]+)(?:px)?"/.exec(attrs)?.[1] ?? '13'
    out.push({ at: m.index, attrs, raw: m[2] ?? '', content: unxml(m[2] ?? ''), size: Number(size) })
  }
  return out
}

/** The bubble's text: a text of 14px or more showing the label (whole, or cut with "…"). */
function bubbles(svg: string, label: string): TextEl[] {
  return texts(svg).filter(t => {
    if (t.size < 14) return false
    const shown = t.content.endsWith('…') ? t.content.slice(0, -1).trimEnd() : t.content
    return shown.length >= 3 && label.startsWith(shown)
  })
}

/** The markup of the nearest <g> that encloses position `at`. */
function enclosingGroup(svg: string, at: number): string {
  let depth = 0
  let start = -1
  const tags = /<g\b[^>]*?(\/?)>|<\/g>/g
  const opens: number[] = []
  for (let m = tags.exec(svg); m && m.index < at; m = tags.exec(svg)) {
    if (m[0].startsWith('</g')) opens.pop()
    else if (m[1] !== '/') opens.push(m.index)
  }
  start = opens[opens.length - 1] ?? -1
  if (start < 0) return ''
  tags.lastIndex = start
  for (let m = tags.exec(svg); m; m = tags.exec(svg)) {
    if (m[0].startsWith('</g')) depth--
    else if (m[1] !== '/') depth++
    if (depth === 0) return svg.slice(start, m.index + m[0].length)
  }
  return svg.slice(start)
}

type RectEl = { x: number; y: number; width: number; height: number; fill?: string }
function rects(markup: string): RectEl[] {
  const out: RectEl[] = []
  const re = /<rect\b([^>]*)\/?>/g
  for (let m = re.exec(markup); m; m = re.exec(markup)) {
    const a = m[1] ?? ''
    const num = (k: string) => Number(new RegExp(`\\b${k}="(-?[\\d.]+)"`).exec(a)?.[1] ?? 0)
    out.push({ x: num('x'), y: num('y'), width: num('width'), height: num('height'), fill: /\bfill="([^"]*)"/.exec(a)?.[1] })
  }
  return out
}

/** The bubble's background: the widest rect in the group that holds the bubble's text. */
function bubbleRect(svg: string, t: TextEl): RectEl {
  const rs = rects(enclosingGroup(svg, t.at))
  expect(rs.length > 0, 'the bubble text sits in a <g> with its background <rect>').toBe(true)
  return rs.reduce((a, b) => (b.width > a.width ? b : a))
}

type AnimEl = { tag: string; attrs: Record<string, string> }
/** `actual` within 0.006 of `expected` (two decimals). */
function near(actual: number, expected: number, tol = 0.006): void {
  expect(Math.abs(actual - expected) <= tol, `${actual} should be ${expected} (±${tol})`).toBe(true)
}

/** Every SMIL animation element with its attributes. */function anims(svg: string): AnimEl[] {
  const out: AnimEl[] = []
  const re = /<(animateTransform|animateMotion|animate|set)\b([^>]*?)\/?>/g
  for (let m = re.exec(svg); m; m = re.exec(svg)) {
    const attrs: Record<string, string> = {}
    const ar = /([\w:-]+)="([^"]*)"/g
    for (let a = ar.exec(m[2] ?? ''); a; a = ar.exec(m[2] ?? '')) attrs[a[1]!] = a[2]!
    out.push({ tag: m[1]!, attrs })
  }
  return out
}

/** A clock value in seconds ("-25.00s", "900ms", absent = 0). */
function seconds(v: string | undefined): number {
  if (v === undefined) return 0
  const m = /^\s*(-?[\d.]+)\s*(ms|s)?\s*$/.exec(v)
  if (!m) throw new Error(`not a plain clock value: ${v}`)
  return Number(m[1]) / (m[2] === 'ms' ? 1000 : 1)
}

const loops = (svg: string) => anims(svg).filter(a => a.attrs.repeatCount === 'indefinite')
const loopOf = (svg: string, dur: string) => {
  const found = loops(svg).filter(a => a.attrs.dur === dur)
  expect(found.length, `one looping animation with dur="${dur}"`).toBe(1)
  return found[0]!
}

/** Whether `a` and `b` are the same point of a loop `dur` long, within `tol` seconds. */
function sameInLoop(a: number, b: number, dur: number, tol: number): boolean {
  const d = (((a - b) % dur) + dur) % dur
  return d <= tol || d >= dur - tol
}

// ---- 1. the lead's bubble shows the task title ------------------------------------------

test('bubble: the lead hands a new agent its task title, big, instead of "à toi"', () => {
  const label = 'Écrire les tests'
  const svg = svgOf({
    desks: [mk('old', 'rest', NOW - 60_000, { label: 'Ancienne tâche finie' }), mk('new', 'busy', NOW - 1000, { label })],
    lead: { mood: 'rest', color: '#d97757' },
    now: NOW,
    epoch: NOW - 5000,
    freshMs: FRESH,
  })
  expect(svg).not.toMatch(/à toi/)
  const found = bubbles(svg, label)
  expect(found.length, 'exactly one bubble text (14px or more) showing the new task title').toBe(1)
  const b = found[0]!
  expect(b.content).toBe(label)
  expect(b.size).toBeGreaterThanOrEqual(14)
  // Clearly bigger than the desk labels (10px) and name tags (11px).
  const nameTag = texts(svg).find(t => t.content === 'Sonnet')
  expect(nameTag).toBeTruthy()
  expect(b.size).toBeGreaterThanOrEqual(nameTag!.size + 3)
  // Only an arriving agent gets a bubble.
  expect(bubbles(svg, 'Ancienne tâche finie')).toHaveLength(0)
})

test('bubble: sized to its text, and kept inside the scene', () => {
  const at = (label: string, n: number) => {
    const desks = Array.from({ length: n }, (_, i) =>
      i === n - 1 ? mk(`d${i}`, 'busy', NOW - 1000, { label }) : mk(`d${i}`, 'rest', NOW - 60_000, { label: `vieux ${i}` }),
    )
    const svg = svgOf({ desks, lead: { mood: 'rest', color: '#d97757' }, now: NOW, epoch: NOW, freshMs: FRESH })
    const found = bubbles(svg, label)
    expect(found.length, `one bubble for "${label}"`).toBe(1)
    const t = found[0]!
    return { t, r: bubbleRect(svg, t), w: sceneSize(n).w }
  }
  const short = at('Fix', 1)
  const long = at('Relire le module de paiement', 1) // 28 characters, not cut
  for (const { t, r } of [short, long]) {
    const chars = Array.from(t.content).length
    // A monospace glyph is about 0.55em wide: the rect holds the text, without being far wider.
    expect(r.width).toBeGreaterThanOrEqual(chars * t.size * 0.5)
    expect(r.width).toBeLessThanOrEqual(chars * t.size + 48)
    expect(r.height).toBeGreaterThanOrEqual(t.size)
  }
  expect(long.r.width).toBeGreaterThan(short.r.width + 100)
  // The last column of a row, next to the door: the bubble still fits in the scene.
  const edge = at('Analyser tous les fichiers du dépôt et rédiger un rapport', 4)
  expect(edge.r.x).toBeGreaterThanOrEqual(0)
  expect(edge.r.x + edge.r.width).toBeLessThanOrEqual(edge.w)
})

test('bubble: a long title is cut with "…" at about 32 characters', () => {
  const label = 'Analyser tous les fichiers du dépôt et rédiger un rapport complet'
  const svg = svgOf({
    desks: [mk('new', 'busy', NOW - 1000, { label })],
    lead: { mood: 'rest', color: '#d97757' },
    now: NOW,
    epoch: NOW,
    freshMs: FRESH,
  })
  const found = bubbles(svg, label)
  expect(found.length).toBe(1)
  const shown = found[0]!.content
  expect(shown.endsWith('…')).toBe(true)
  const n = Array.from(shown).length
  expect(n).toBeLessThanOrEqual(32)
  expect(n).toBeGreaterThanOrEqual(24)
  expect(label.startsWith(shown.slice(0, -1).trimEnd())).toBe(true)
})

test('bubble: the title is escaped for XML', () => {
  const label = 'Fix <Pane> & "q"'
  const svg = svgOf({
    desks: [mk('new', 'busy', NOW - 1000, { label })],
    lead: { mood: 'rest', color: '#d97757' },
    now: NOW,
    epoch: NOW,
    freshMs: FRESH,
  })
  expect(svg).not.toContain('<Pane>')
  const found = bubbles(svg, label)
  expect(found.length).toBe(1)
  expect(found[0]!.raw).toBe('Fix &lt;Pane&gt; &amp; &quot;q&quot;')
  expect(found[0]!.content).toBe(label)
})

// ---- 2a. the scene key: rebuilt only on a significant change -----------------------------

test('officeKey: happy and rest are one state; time passing alone changes nothing', () => {
  const old = NOW - 60_000
  const a = officeKey([mk('a', 'busy', old), mk('b', 'happy', old)], 'rest', NOW, FRESH)
  expect(typeof a).toBe('string')
  expect(officeKey([mk('a', 'busy', old), mk('b', 'happy', old)], 'rest', NOW, FRESH)).toBe(a)
  expect(officeKey([mk('a', 'busy', old), mk('b', 'rest', old)], 'rest', NOW, FRESH)).toBe(a)
  // Also for a desk still in its arrival window.
  const fresh = NOW - 2000
  expect(officeKey([mk('c', 'happy', fresh)], 'rest', NOW, FRESH)).toBe(officeKey([mk('c', 'rest', fresh)], 'rest', NOW, FRESH))
  // The clock moving, with nothing crossing a boundary, keeps the key.
  expect(officeKey([mk('a', 'busy', old)], 'rest', NOW + 30_000, FRESH)).toBe(officeKey([mk('a', 'busy', old)], 'rest', NOW, FRESH))
  expect(officeKey([mk('c', 'busy', fresh)], 'rest', NOW + 3000, FRESH)).toBe(officeKey([mk('c', 'busy', fresh)], 'rest', NOW, FRESH))
})

test('officeKey: busy, error and the lead going busy change the key', () => {
  const old = NOW - 60_000
  const key = (mood: Mood, lead: Mood = 'rest') => officeKey([mk('a', 'rest', old), mk('b', mood, old)], lead, NOW, FRESH)
  expect(key('busy')).not.toBe(key('rest'))
  expect(key('busy')).not.toBe(key('happy'))
  expect(key('error')).not.toBe(key('rest'))
  expect(key('error')).not.toBe(key('happy'))
  expect(key('error')).not.toBe(key('busy'))
  expect(key('rest', 'busy')).not.toBe(key('rest', 'rest'))
})

test('officeKey: a desk arriving, leaving the list or renamed changes the key; the end of the arrival window does not', () => {
  const old = NOW - 60_000
  const base = [mk('a', 'busy', old), mk('b', 'rest', old)]
  const k = officeKey(base, 'rest', NOW, FRESH)
  expect(officeKey([...base, mk('c', 'busy', NOW - 500)], 'rest', NOW, FRESH)).not.toBe(k)
  expect(officeKey([base[0]!], 'rest', NOW, FRESH)).not.toBe(k)
  expect(officeKey([base[0]!, { ...base[1]!, name: 'Opus' }], 'rest', NOW, FRESH)).not.toBe(k)
  expect(officeKey([base[0]!, { ...base[1]!, label: 'Autre chose' }], 'rest', NOW, FRESH)).not.toBe(k)
  // Arrived 5 s ago: in its arrival window now, out of it 6 s later. The one-off arrival
  // animations end frozen (fill="freeze"), so the scene needs no rebuild for that.
  const arriving = [mk('c', 'busy', NOW - 5000)]
  expect(officeKey(arriving, 'rest', NOW + 6000, FRESH)).toBe(officeKey(arriving, 'rest', NOW, FRESH))
})

test('officeKey: 5 agents launched 300 ms apart and done 15 s later change the key at most twice each', () => {
  // The reviewer's scenario: the key is read every 120 ms for 50 s, the lead busy throughout.
  const T = NOW
  const runs = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, start: T + i * 300, end: T + 15_000 + i * 300 }))
  let last: string | null = null
  const changes: number[] = []
  for (let now = T; now < T + 50_000; now += 120) {
    const desks = runs
      .filter(r => r.start <= now)
      .map((r, i) =>
        mk(r.id, now < r.end ? 'busy' : now - r.end < 4500 ? 'happy' : 'rest', r.start, {
          label: 'x',
          ...(now < r.end ? {} : { endedAt: r.end }),
          seat: i,
        }),
      )
    const k = officeKey(desks, 'busy', now, FRESH)
    if (k !== last) changes.push((now - T) / 1000)
    last = k
  }
  expect(changes.length, `key changes at s: ${changes.join(' ')}`).toBeLessThanOrEqual(10)
})

// ---- 2b. loops resume where they were ----------------------------------------------------

test('loops: the cloud and the clock start from the scene epoch', () => {
  const desks = [mk('a', 'busy', NOW - 60_000)]
  const lead = { mood: 'rest' as Mood, color: '#d97757' }
  const s25 = svgOf({ desks, lead, now: NOW, epoch: NOW - 25_000, freshMs: FRESH })
  near(seconds(loopOf(s25, '40s').attrs.begin), -25)
  near(seconds(loopOf(s25, '60s').attrs.begin), -25)
  // Past a whole loop: modulo the loop's duration.
  const s100 = svgOf({ desks, lead, now: NOW, epoch: NOW - 100_000, freshMs: FRESH })
  near(seconds(loopOf(s100, '40s').attrs.begin), -20)
  near(seconds(loopOf(s100, '60s').attrs.begin), -40)
  // officeWithin keeps the epoch.
  const within = officeWithin({ desks, lead, now: NOW, epoch: NOW - 25_000, freshMs: FRESH } as unknown as Scene)
  near(seconds(loopOf(within.svg, '40s').attrs.begin), -25)
})

test('loops: every looping animation resumes where it was when the scene is rebuilt later', () => {
  const desks = [
    mk('a', 'busy', NOW - 60_000),
    mk('b', 'rest', NOW - 50_000, { kind: 'gemini', role: 'recherche', color: '#2bb3c0', name: 'Gemini Flash' }),
    mk('c', 'error', NOW - 40_000, { role: 'verification' }),
    mk('d', 'busy', NOW - 30_000, { kind: 'gemini', role: 'architecte', color: '#9b72f2', name: 'Gemini Argon' }),
  ]
  const lead = { mood: 'busy' as Mood, color: '#d97757' }
  const epoch = NOW - 25_000
  const delta = 3.33
  const one = loops(svgOf({ desks, lead, now: NOW, epoch, freshMs: FRESH }))
  const two = loops(svgOf({ desks, lead, now: NOW + delta * 1000, epoch, freshMs: FRESH }))
  expect(one.length).toBeGreaterThanOrEqual(6)
  expect(two.length).toBe(one.length)
  one.forEach((a, i) => {
    const b = two[i]!
    expect(b.attrs.dur).toBe(a.attrs.dur)
    const dur = seconds(a.attrs.dur)
    const b1 = seconds(a.attrs.begin)
    const b2 = seconds(b.attrs.begin)
    // A begin is a point inside the loop, given as a negative offset.
    expect(b1).toBeLessThanOrEqual(0)
    expect(b1).toBeGreaterThan(-dur - 0.01)
    expect(
      sameInLoop(b1 - delta, b2, dur, 0.015),
      `loop #${i} (dur ${a.attrs.dur}): begin ${a.attrs.begin} then ${b.attrs.begin ?? '(none)'}, ${delta}s later`,
    ).toBe(true)
  })
  // The cloud is not where it was: the two scenes differ.
  expect(loopOf(svgOf({ desks, lead, now: NOW + delta * 1000, epoch, freshMs: FRESH }), '40s').attrs.begin).not.toBe(
    loopOf(svgOf({ desks, lead, now: NOW, epoch, freshMs: FRESH }), '40s').attrs.begin,
  )
})

test('loops: the epoch moves the loops only; arrivals stay timed from arrivedAt', () => {
  const desks = [mk('old', 'rest', NOW - 60_000), mk('new', 'busy', NOW - 1000, { label: 'Nouvelle tâche' })]
  const lead = { mood: 'rest' as Mood, color: '#d97757' }
  const a = svgOf({ desks, lead, now: NOW, epoch: NOW - 25_000, freshMs: FRESH })
  const b = svgOf({ desks, lead, now: NOW, epoch: NOW - 7000, freshMs: FRESH })
  const once = (svg: string) => anims(svg).filter(x => x.attrs.fill === 'freeze')
  expect(once(a).length).toBeGreaterThanOrEqual(3)
  expect(once(a).map(x => x.attrs.begin)).toEqual(once(b).map(x => x.attrs.begin))
  expect(once(a).every(x => x.attrs.repeatCount === undefined)).toBe(true)
  // The walk in through the door started when the agent arrived, 1 s ago.
  const walk = once(a).filter(x => x.attrs.dur === '1.8s')
  expect(walk.length).toBe(1)
  near(seconds(walk[0]!.attrs.begin), -1)
  // The loops do follow the epoch.
  near(seconds(loopOf(a, '40s').attrs.begin), -25)
  near(seconds(loopOf(b, '40s').attrs.begin), -7)
})

// ---- 3. an agent done for a while packs up and leaves -------------------------------------

const LEAD = { mood: 'rest' as Mood, color: '#d97757' }
const stayer = () => mk('stay', 'busy', NOW - 120_000, { name: 'Opus', label: 'Reste là' })
const leaver = (mood: Mood, endedAt: number) =>
  mk('go', mood, NOW - 120_000, { name: 'Haiku', label: 'Partir bientôt', endedAt })

/** Numbers of an animateTransform's path: every x of `values`, `from` and `to`. */
function xs(a: AnimEl): number[] {
  return [a.attrs.values ?? '', a.attrs.from ?? '', a.attrs.to ?? '']
    .flatMap(v => v.split(';'))
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => Number(p.split(/[\s,]+/)[0]))
    .filter(n => Number.isFinite(n))
}
const fadesOut = (a: AnimEl) =>
  a.attrs.attributeName === 'opacity' &&
  a.attrs.fill === 'freeze' &&
  (a.attrs.to === '0' || (a.attrs.values ?? '').split(';').pop()?.trim() === '0')

test('leaving: the delays are exported, about 20 s after the end and a 4 s walk out', () => {
  const after = constant('LEAVE_AFTER_MS')
  const anim = constant('LEAVE_ANIM_MS')
  expect(after).toBeGreaterThanOrEqual(15_000)
  expect(after).toBeLessThanOrEqual(30_000)
  expect(anim).toBeGreaterThanOrEqual(2000)
  expect(anim).toBeLessThanOrEqual(8000)
})

test('leaving: before the delay the agent stays at its desk; its departure is only scheduled', () => {
  const after = constant('LEAVE_AFTER_MS')
  const svg = svgOf({ desks: [stayer(), leaver('rest', NOW - after + 1000)], lead: LEAD, now: NOW, epoch: NOW, freshMs: FRESH })
  expect(svg).toContain('Haiku')
  expect(svg).toContain('Partir bientôt')
  expect(marks(svg)).not.toContain('desk-empty')
  // Whatever is planned starts 1 s from now, when the departure does: nothing has moved yet.
  for (const a of anims(svg).filter(x => x.attrs.fill === 'freeze')) expect(seconds(a.attrs.begin)).toBeGreaterThanOrEqual(0.99)
})

/** Where each <g> enclosing `at` starts, innermost last. */
function ancestors(svg: string, at: number): number[] {
  const tags = /<g\b[^>]*?(\/?)>|<\/g>/g
  const opens: number[] = []
  for (let m = tags.exec(svg); m && m.index < at; m = tags.exec(svg)) {
    if (m[0].startsWith('</g')) opens.pop()
    else if (m[1] !== '/') opens.push(m.index)
  }
  return opens
}
/** The animations a <g> starting at `start` holds as its first children. */
function ownAnims(svg: string, start: number): AnimEl[] {
  const open = /<g\b[^>]*>/y
  open.lastIndex = start
  const m = open.exec(svg)
  if (!m) return []
  const run = /^(?:\s*<(?:animateTransform|animateMotion|animate|set)\b[^>]*?\/>)*/.exec(svg.slice(start + m[0].length))?.[0] ?? ''
  return anims(run)
}
/** Whether something at `at` sits inside a group that fades out (its own opacity animation to 0). */
const fadedAt = (svg: string, at: number) => ancestors(svg, at).some(s => ownAnims(svg, s).some(fadesOut))

test('leaving: a scene built when the agent finishes already plays its departure, later, without a rebuild', () => {
  const after = constant('LEAVE_AFTER_MS') / 1000
  const anim = constant('LEAVE_ANIM_MS') / 1000
  // Built 0.1 s after the end: the departure starts LEAVE_AFTER_MS - 0.1 s from now.
  const go = mk('go', 'rest', NOW - 120_000, { name: 'Haiku', label: 'Partir bientôt', role: 'recherche', endedAt: NOW - 100 })
  const svg = svgOf({ desks: [stayer(), go], lead: LEAD, now: NOW, epoch: NOW, freshMs: FRESH })
  const t0 = after - 0.1
  expect(marks(svg).some(t => t.includes('carton')), 'the box is in the scene, shown when the departure starts').toBe(true)
  const once = anims(svg).filter(x => x.attrs.fill === 'freeze')
  expect(once.length).toBeGreaterThanOrEqual(3)
  for (const a of once) {
    const b = seconds(a.attrs.begin)
    expect(b, `${a.tag} begin ${a.attrs.begin}`).toBeGreaterThanOrEqual(t0 - 0.01)
    expect(b + seconds(a.attrs.dur), `${a.tag} ends within the departure`).toBeLessThanOrEqual(t0 + anim + 0.01)
  }
  const walks = once.filter(x => x.tag === 'animateTransform')
  expect(walks.length).toBeGreaterThanOrEqual(1)
  expect(Math.max(...walks.flatMap(xs)), 'the walk goes to the door').toBeGreaterThan(200)
  expect(once.some(fadesOut), 'the agent fades to 0').toBe(true)
  // The name tag fades with the agent; the desk and its decor stay (an empty desk, drawn animated).
  const tag = texts(svg).find(t => t.content === 'Haiku')
  expect(tag, 'the name tag is still in the markup until the departure').toBeTruthy()
  expect(fadedAt(svg, tag!.at), 'the name tag fades out').toBe(true)
  const decor = svg.indexOf('href="#desk-deco-recherche"')
  expect(decor, 'the desk keeps its decor').toBeGreaterThan(0)
  expect(fadedAt(svg, decor), 'the desk itself does not fade').toBe(false)
})

test('leaving: a box, a walk to the door, a fade, timed from the end of the delay', () => {
  const after = constant('LEAVE_AFTER_MS')
  for (const mood of ['rest', 'happy', 'error'] as const) {
    // 1 s into the departure, then 0.5 s later.
    const endedAt = NOW - after - 1000
    const a = svgOf({ desks: [stayer(), leaver(mood, endedAt)], lead: LEAD, now: NOW, epoch: NOW, freshMs: FRESH })
    const b = svgOf({ desks: [stayer(), leaver(mood, endedAt)], lead: LEAD, now: NOW + 500, epoch: NOW, freshMs: FRESH })
    expect(a, `${mood}: still drawn while leaving`).toContain('Haiku')
    expect(marks(a).some(t => t.includes('carton')), `${mood}: an element whose id or class holds "carton"`).toBe(true)
    const once = (svg: string) => anims(svg).filter(x => x.attrs.fill === 'freeze')
    const fa = once(a)
    const fb = once(b)
    expect(fa.length).toBeGreaterThanOrEqual(2)
    // To the door, on the right of the room (the desk is in the first column).
    const walks = fa.filter(x => x.tag === 'animateTransform')
    expect(walks.length).toBeGreaterThanOrEqual(1)
    expect(Math.max(...walks.flatMap(xs))).toBeGreaterThan(200)
    expect(fa.some(fadesOut), `${mood}: an opacity animation to 0, fill="freeze"`).toBe(true)
    // Timed from endedAt + LEAVE_AFTER_MS: none starts before the departure, and they move with now.
    for (const x of fa) expect(seconds(x.attrs.begin)).toBeGreaterThanOrEqual(-1.01)
    expect(fb.length).toBe(fa.length)
    fa.forEach((x, i) => near(seconds(fb[i]!.attrs.begin), seconds(x.attrs.begin) - 0.5))
  }
})

test('leaving: once gone, the agent is no longer drawn; its desk stays, empty (desk-empty)', () => {
  const after = constant('LEAVE_AFTER_MS')
  const anim = constant('LEAVE_ANIM_MS')
  for (const mood of ['rest', 'happy', 'error'] as const) {
    const svg = svgOf({
      desks: [stayer(), leaver(mood, NOW - after - anim - 1000)],
      lead: LEAD,
      now: NOW,
      epoch: NOW,
      freshMs: FRESH,
    })
    expect(svg, mood).not.toContain('Haiku')
    expect(svg, mood).not.toContain('Partir bientôt')
    expect(marks(svg).some(t => t.includes('carton'))).toBe(false)
    expect(svg).toContain('Opus')
    expect(marks(svg).filter(t => t === 'desk-empty').length, `${mood}: one desk marked desk-empty`).toBe(1)
  }
  // Alone in the room: the empty desk keeps its role decor and its item, with no task sheet and its screen off.
  const role = 'recherche' as const
  const gone = mk('go', 'rest', NOW - 120_000, { name: 'Haiku', label: 'Partir bientôt', role, endedAt: NOW - after - anim - 1000 })
  const svg = svgOf({ desks: [gone], lead: LEAD, now: NOW, epoch: NOW, freshMs: FRESH })
  expect(marks(svg)).toContain('desk-empty')
  expect(marksWith(svg, 'desk-deco-')).toEqual([`desk-deco-${role}`])
  expect(marksWith(svg, 'desk-item-').length).toBe(1)
  const sheets = rects(svg).filter(r => r.fill === '#efe6c8' && r.width === 16 && r.height === 9)
  expect(sheets.length, 'no task sheet on the empty desk').toBe(0)
  for (const lit of ['#10161f', '#3a1414', '#123018']) expect(svg, `screen off: no ${lit} screen`).not.toContain(`fill="${lit}"`)
})

/** Where a name tag is drawn: the x, y of the <text> showing exactly `name`. */
function tagAt(svg: string, name: string): { x: number; y: number } {
  const found = [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].filter(m => unxml(m[2] ?? '') === name)
  expect(found.length, `one name tag "${name}"`).toBe(1)
  const a = found[0]![1] ?? ''
  return { x: Number(/\bx="(-?[\d.]+)"/.exec(a)?.[1]), y: Number(/\by="(-?[\d.]+)"/.exec(a)?.[1]) }
}

/** A desk dropping from above: a freeze animateTransform that only moves vertically, starting above. */
const drops = (svg: string) =>
  anims(svg).filter(a => {
    if (a.tag !== 'animateTransform' || a.attrs.fill !== 'freeze' || !a.attrs.values) return false
    const pts = a.attrs.values.split(';').map(p => p.trim().split(/[\s,]+/).map(Number))
    return pts.every(p => p[0] === 0) && (pts[0]?.[1] ?? 0) < 0
  })

test('leaving: a new agent takes the first empty desk, at its place, walking in without a desk drop', () => {
  const after = constant('LEAVE_AFTER_MS')
  const anim = constant('LEAVE_ANIM_MS')
  const old = (endedAt?: number) =>
    mk('old', 'rest', NOW - 200_000, { name: 'Haiku', label: 'Ancien', role: 'verification', seat: 0, ...(endedAt === undefined ? {} : { endedAt }) })
  const stay = mk('stay', 'busy', NOW - 150_000, { name: 'Opus', label: 'Reste là', role: 'architecte', seat: 1 })
  // The newcomer's seat is given once, at its arrival, by assignSeat.
  const newcomer = (arrivedAt: number, others: Desk[]) =>
    mk('new-1', 'busy', arrivedAt, {
      name: 'Fable',
      label: 'Nouvelle tâche',
      role: 'creation',
      kind: 'gemini',
      color: '#c76b98',
      seat: assignSeat(others, arrivedAt),
    })
  const scene = (desks: Desk[], now = NOW) => svgOf({ desks, lead: LEAD, now, epoch: NOW, freshMs: FRESH })

  // Where the desks sit while everyone is still there.
  const before = scene([old(), stay, newcomer(NOW - 1000, [old(), stay])])
  const slot0 = tagAt(before, 'Haiku')
  const slot1 = tagAt(before, 'Opus')
  const slot2 = tagAt(before, 'Fable')
  // The old agent was fully gone before the newcomer arrived: the newcomer sits at its desk.
  const goneAt = NOW - 100_000
  const fresh = newcomer(NOW - 1000, [old(goneAt), stay])
  expect(fresh.seat).toBe(0)
  const reuse = scene([old(goneAt), stay, fresh])
  expect(reuse).not.toContain('Haiku')
  expect(tagAt(reuse, 'Fable')).toEqual(slot0)
  expect(tagAt(reuse, 'Opus')).toEqual(slot1)
  expect(marks(reuse)).not.toContain('desk-empty')
  // No desk drop; the walk in through the door, and the lead's visit with the bubble.
  expect(drops(reuse)).toHaveLength(0)
  expect(anims(reuse).filter(a => a.attrs.fill === 'freeze' && a.attrs.dur === '1.8s')).toHaveLength(1)
  expect(bubbles(reuse, 'Nouvelle tâche')).toHaveLength(1)
  // The desk's decor is now the newcomer's.
  expect(marksWith(reuse, 'desk-deco-').sort()).toEqual(['desk-deco-architecte', 'desk-deco-creation'])
  const itemOf = (d: Desk) => marksWith(scene([{ ...d, arrivedAt: NOW - 60_000, seat: 0 } as Desk]), 'desk-item-')
  expect(marksWith(reuse, 'desk-item-').sort()).toEqual([...new Set([...itemOf(stay), ...itemOf(fresh)])].sort())
  // Stable: the same data, rebuilt later, gives the same places.
  expect(tagAt(scene([old(goneAt), stay, fresh], NOW + 2000), 'Fable')).toEqual(slot0)

  // Arrived before the old agent had finished leaving (gone at NOW - 2 s, arrived at NOW - 3 s):
  // a new desk at the end, which drops in; the old desk stays empty.
  const early = old(NOW - after - anim - 2000)
  const late = newcomer(NOW - 3000, [early, stay])
  expect(late.seat).toBe(2)
  const tooEarly = scene([early, stay, late])
  expect(tagAt(tooEarly, 'Fable')).toEqual(slot2)
  expect(drops(tooEarly).length).toBeGreaterThanOrEqual(1)
  expect(marks(tooEarly).filter(t => t === 'desk-empty')).toHaveLength(1)
})

test('leaving: a busy agent, or one with no endedAt, never leaves; a done one beside them does', () => {
  const svg = svgOf({
    desks: [
      mk('b', 'busy', NOW - 600_000, { name: 'Haiku', label: 'Toujours là', endedAt: NOW - 500_000 }),
      mk('r', 'rest', NOW - 600_000, { name: 'Fable', label: 'Sans fin connue' }),
      mk('g', 'rest', NOW - 600_000, { name: 'Gemini Hydrogen', label: 'Déjà parti', endedAt: NOW - 500_000 }),
    ],
    lead: LEAD,
    now: NOW,
    epoch: NOW,
    freshMs: FRESH,
  })
  expect(svg).toContain('Haiku')
  expect(svg).toContain('Fable')
  expect(marks(svg).some(t => t.includes('carton'))).toBe(false)
  expect(svg).not.toContain('Gemini Hydrogen')
})

test('officeKey: the departure is planned at the end, so neither its start nor its end changes the key', () => {
  const after = constant('LEAVE_AFTER_MS')
  const anim = constant('LEAVE_ANIM_MS')
  const endedAt = NOW
  const key = (now: number) => officeKey([stayer(), leaver('rest', endedAt)], 'rest', now, FRESH)
  const done = key(NOW + 100)
  for (const t of [1000, after - 1000, after + 100, after + anim - 100, after + anim + 100, after + anim + 600_000])
    expect(key(NOW + t), `${t} ms after the end`).toBe(done)
  // The end itself does change it.
  expect(officeKey([stayer(), mk('go', 'busy', NOW - 120_000, { name: 'Haiku', label: 'Partir bientôt' })], 'rest', NOW - 100, FRESH)).not.toBe(done)
})

// ---- 4. decoration ------------------------------------------------------------------------

const ROLES = ['verification', 'recherche', 'creation', 'architecte', 'orchestrateur', 'generaliste'] as const

test('decor: the room has at least four decorations marked deco-*, and the lead its own', () => {
  const svg = svgOf({ desks: [], lead: LEAD, now: NOW, epoch: NOW, freshMs: FRESH })
  expect(marksWith(svg, 'deco-').length).toBeGreaterThanOrEqual(4)
  expect(marksWith(svg, 'lead-deco').length).toBeGreaterThanOrEqual(1)
})

/** Every desk-deco / desk-item piece drawn in the scene (outside <defs>): by <use href="#…"> or by class. */
function drawn(svg: string, prefix: string): string[] {
  const body = svg.replace(/<defs>[\s\S]*?<\/defs>/, '')
  const out: string[] = []
  for (const m of body.matchAll(/<use\b[^>]*\bhref="#([^"]+)"/g)) if (m[1]!.startsWith(prefix)) out.push(m[1]!)
  for (const m of body.matchAll(/\bclass="([^"]*)"/g)) for (const t of m[1]!.split(/\s+/)) if (t.startsWith(prefix)) out.push(t)
  return out.sort()
}

test('decor: each desk draws the objects of its role (desk-deco-<role>), once', () => {
  for (const role of ROLES) {
    const svg = svgOf({ desks: [mk('x', 'rest', NOW - 60_000, { role })], lead: LEAD, now: NOW, epoch: NOW, freshMs: FRESH })
    expect(drawn(svg, 'desk-deco-'), role).toEqual([`desk-deco-${role}`])
  }
  const two = svgOf({
    desks: [mk('x', 'rest', NOW - 60_000, { role: 'creation' }), mk('y', 'busy', NOW - 60_000, { role: 'creation' })],
    lead: LEAD,
    now: NOW,
    epoch: NOW,
    freshMs: FRESH,
  })
  expect(drawn(two, 'desk-deco-')).toEqual(['desk-deco-creation', 'desk-deco-creation'])
})

test('decor: each desk has a small object picked from its id, stable and varied (desk-item-*)', () => {
  const itemOf = (id: string, now = NOW, epoch = NOW) => {
    const svg = svgOf({ desks: [mk(id, 'rest', now - 60_000)], lead: LEAD, now, epoch, freshMs: FRESH })
    const items = drawn(svg, 'desk-item-')
    expect(items.length, `one desk-item-* drawn for desk ${id}`).toBe(1)
    return items[0]!
  }
  const ids = Array.from({ length: 12 }, (_, i) => `agent-${i}-${(i * 7919).toString(36)}`)
  const picked = ids.map(id => itemOf(id))
  expect(new Set(picked).size).toBeGreaterThanOrEqual(3)
  // The same id picks the same object, whatever the time, the epoch or the desk's place.
  ids.forEach((id, i) => expect(itemOf(id, NOW + 77_777, NOW - 5000)).toBe(picked[i]))
  const pair = svgOf({
    desks: [mk(ids[1]!, 'rest', NOW - 60_000), mk(ids[0]!, 'busy', NOW - 60_000)],
    lead: LEAD,
    now: NOW,
    epoch: NOW,
    freshMs: FRESH,
  })
  expect(drawn(pair, 'desk-item-')).toEqual([picked[0]!, picked[1]!].sort())
})

const crowd = (n: number, freshFrom: number) =>
  Array.from({ length: n }, (_, i) =>
    mk(`d${i}`, i % 3 === 2 ? 'error' : 'busy', i >= freshFrom ? NOW - 500 * (i - freshFrom + 1) : NOW - 60_000, {
      role: ROLES[i % ROLES.length],
      kind: i % 2 ? 'gemini' : 'claude',
      color: i % 2 ? '#2bb3c0' : '#e0a84e',
      name: i % 2 ? `Gemini Flash ${i}` : `Sonnet ${i}`,
      label: `Une tâche assez longue numéro ${i}`,
    }),
  )

for (const [n, freshFrom] of [
  [9, 6],
  [30, 27],
] as const) {
  test(`decor: ${n} decorated desks fit the SVG budget, none hidden, each with its decor drawn`, () => {
    const desks = crowd(n, freshFrom)
    const within = officeWithin({ desks, lead: { mood: 'busy', color: '#d97757' }, now: NOW, epoch: NOW - 12_345, freshMs: FRESH } as unknown as Scene)
    expect(within.hidden).toBe(0)
    expect(within.svg.length).toBeLessThanOrEqual(office.SVG_BUDGET)
    expect(marksWith(within.svg, 'deco-').length).toBeGreaterThanOrEqual(4)
    expect(drawn(within.svg, 'desk-deco-')).toEqual(desks.map(d => `desk-deco-${d.role}`).sort())
    expect(drawn(within.svg, 'desk-item-').length).toBe(n)
    for (let i = 0; i < n; i++) expect(within.svg).toContain(i % 2 ? `Gemini Flash ${i}` : `Sonnet ${i}`)
  })
}
// ---- 5. seats: given once, at arrival ------------------------------------------------------

test('seats: assignSeat gives the first seat free at the arrival, else a new one after the others', () => {
  const after = constant('LEAVE_AFTER_MS')
  const anim = constant('LEAVE_ANIM_MS')
  const busy = (id: string, seat: number) => mk(id, 'busy', NOW - 100_000, { seat })
  const gone = (id: string, seat: number, endedAt: number) => mk(id, 'rest', NOW - 200_000, { seat, endedAt })
  expect(assignSeat([], NOW)).toBe(0)
  expect(assignSeat([busy('a', 0), busy('b', 1)], NOW)).toBe(2)
  // Seat 0's agent had walked out before this arrival: seat 0 again.
  expect(assignSeat([gone('a', 0, NOW - after - anim - 1), busy('b', 1)], NOW)).toBe(0)
  // ...but not if it was still leaving when this one arrived.
  expect(assignSeat([gone('a', 0, NOW - after - anim + 1), busy('b', 1)], NOW)).toBe(2)
  // A seat is taken while its latest agent works there, even if an earlier one left it.
  expect(assignSeat([gone('a', 0, NOW - 500_000), busy('c', 0), busy('b', 1)], NOW)).toBe(2)
  // A seat no listed desk holds (its run dropped from the history) is an empty desk: free, lowest first.
  expect(assignSeat([busy('b', 1), busy('c', 2)], NOW)).toBe(0)
  expect(assignSeat([busy('a', 0), busy('b', 1), gone('d', 3, NOW - 500_000), busy('c', 2)], NOW)).toBe(3)
  // A busy agent, or one with no known end, never frees its seat.
  expect(assignSeat([mk('e', 'busy', NOW - 500_000, { seat: 0, endedAt: NOW - 400_000 })], NOW)).toBe(1)
  expect(assignSeat([mk('f', 'rest', NOW - 500_000, { seat: 0 })], NOW)).toBe(1)
})

test('seats: each desk is drawn at its seat; dropping the oldest run moves nobody, an empty desk stays empty', () => {
  const after = constant('LEAVE_AFTER_MS')
  const anim = constant('LEAVE_ANIM_MS')
  const A = mk('A', 'rest', NOW - 200_000, { name: 'Aname', seat: 0, endedAt: NOW - after - anim - 60_000 })
  const B = mk('B', 'busy', NOW - 185_000, { name: 'Bname', seat: 1 })
  const C = mk('C', 'busy', NOW - 150_000, { name: 'Cname', seat: 2 })
  const D = mk('D', 'busy', NOW - 100_000, { name: 'Dname', seat: 5 })
  const scene = (desks: Desk[]) => svgOf({ desks, lead: LEAD, now: NOW, epoch: 0, freshMs: FRESH })
  // Where seats 1, 2 and 5 are.
  const grid = scene(Array.from({ length: 6 }, (_, i) => mk(`s${i}`, 'busy', NOW - 300_000 + i, { name: `S${i}`, seat: i })))
  const full = scene([A, B, C, D])
  const trimmed = scene([B, C, D])
  for (const [name, seat] of [
    ['Bname', 1],
    ['Cname', 2],
    ['Dname', 5],
  ] as const) {
    expect(tagAt(full, name), `${name} at seat ${seat}`).toEqual(tagAt(grid, `S${seat}`))
    expect(tagAt(trimmed, name), `${name} still at seat ${seat} once A is dropped`).toEqual(tagAt(grid, `S${seat}`))
  }
  // Seats 0, 3 and 4 hold no one: three empty desks, with or without A in the list.
  expect(marks(full).filter(t => t === 'desk-empty')).toHaveLength(3)
  expect(marks(trimmed).filter(t => t === 'desk-empty')).toHaveLength(3)
  const box = (svg: string) => /viewBox="([^"]+)"/.exec(svg)?.[1]
  expect(box(trimmed)).toBe(box(full))
  expect(box(full)).toBe(box(grid))
})

// ---- 6. the lead's round with many newcomers -----------------------------------------------

const burst = (n: number) =>
  Array.from({ length: n }, (_, i) => mk(`b${i}`, 'busy', NOW + i * 50, { label: `Tâche ${i}`, name: `Agent ${i}`, seat: i }))

/** Each label's bubble in a scene built at `builtAt`: when it shows and for how long, in s after NOW. */
function bubbleTimes(svg: string, labels: string[], builtAt: number) {
  return labels.map(label => {
    const found = bubbles(svg, label)
    if (found.length !== 1) return undefined
    const own = ancestors(svg, found[0]!.at)
      .flatMap(s => ownAnims(svg, s))
      .filter(a => a.attrs.attributeName === 'opacity')
    expect(own.length, `the bubble "${label}" has an opacity animation`).toBeGreaterThanOrEqual(1)
    const a = own[0]!
    const begin = seconds(a.attrs.begin)
    return { begin, at: begin + (builtAt - NOW) / 1000, dur: seconds(a.attrs.dur) }
  })
}

/** The lead's round: a freeze animateTransform from home (0,0) back home, with stops between. */
function round(svg: string, builtAt: number) {
  const found = anims(svg).filter(a => {
    if (a.tag !== 'animateTransform' || a.attrs.fill !== 'freeze' || !a.attrs.values) return false
    const pts = a.attrs.values.split(';').map(p => p.trim())
    return pts.length >= 3 && /^0[ ,]0$/.test(pts[0]!) && /^0[ ,]0$/.test(pts[pts.length - 1]!)
  })
  if (!found.length) return undefined
  expect(found.length, 'one round of the lead').toBe(1)
  const a = found[0]!
  return { at: seconds(a.attrs.begin) + (builtAt - NOW) / 1000, dur: seconds(a.attrs.dur), values: a.attrs.values, keyTimes: a.attrs.keyTimes }
}

test('round: 8 newcomers at once each get their bubble, shown at least 1 s, all within the arrival window', () => {
  const desks = burst(8)
  const builtAt = NOW + 350 // right after the last arrival
  const svg = svgOf({ desks, lead: { mood: 'busy', color: '#d97757' }, now: builtAt, epoch: 0, freshMs: FRESH })
  const times = bubbleTimes(svg, desks.map(d => d.label), builtAt)
  times.forEach((t, i) => {
    expect(t, `a bubble for Tâche ${i}`).toBeTruthy()
    expect(t!.begin, `Tâche ${i}: shown after the scene is built`).toBeGreaterThanOrEqual(0)
    expect(t!.dur, `Tâche ${i}: shown at least 1 s`).toBeGreaterThanOrEqual(1)
    expect(t!.at + 1, `Tâche ${i}: handed over within the first arrival's window (at ${t!.at.toFixed(2)} s)`).toBeLessThanOrEqual(FRESH / 1000)
  })
})

test('round: never recomputed on the way, neither by a later newcomer of the same burst nor by a rebuild', () => {
  const desks = burst(8)
  const lead = { mood: 'busy' as Mood, color: '#d97757' }
  const labels = desks.map(d => d.label)
  const built = (n: number, at: number) => svgOf({ desks: desks.slice(0, n), lead, now: at, epoch: 0, freshMs: FRESH })
  const full = built(8, NOW + 350)
  const ref = bubbleTimes(full, labels, NOW + 350)
  // Built after the 4th arrival: those four are handed over at the same moments as in the full burst.
  const four = bubbleTimes(built(4, NOW + 150), labels.slice(0, 4), NOW + 150)
  four.forEach((t, i) => near(t!.at, ref[i]!.at, 0.011))
  // Rebuilt later, even past the first arrivals' windows: what is still to come is unchanged.
  const lead0 = round(full, NOW + 350)
  expect(lead0, 'the lead walks a round').toBeTruthy()
  for (const at of [NOW + 5000, NOW + 10_200, NOW + 12_000]) {
    const again = built(8, at)
    const t = (at - NOW) / 1000
    bubbleTimes(again, labels, at).forEach((b, i) => {
      if (ref[i]!.at + ref[i]!.dur <= t) return // over before the rebuild: may be left out
      expect(b, `rebuilt at +${t}s: the bubble of Tâche ${i} is still planned`).toBeTruthy()
      near(b!.at, ref[i]!.at, 0.011)
    })
    if (lead0!.at + lead0!.dur > t) {
      const r = round(again, at)
      expect(r, `rebuilt at +${t}s mid-round: the lead keeps walking`).toBeTruthy()
      near(r!.at, lead0!.at, 0.011)
      expect(r!.dur).toBe(lead0!.dur)
      expect(r!.values).toBe(lead0!.values)
    }
  }
})

// ---- 7. small things ---------------------------------------------------------------------

test('loops: an epoch of 0 works, every loop begin stays within ]-dur, 0]', () => {
  const desks = [mk('a', 'busy', NOW - 60_000), mk('b', 'rest', NOW - 50_000, { kind: 'gemini', role: 'recherche' })]
  const svg = svgOf({ desks, lead: { mood: 'busy', color: '#d97757' }, now: NOW, epoch: 0, freshMs: FRESH })
  const ls = loops(svg)
  expect(ls.length).toBeGreaterThanOrEqual(4)
  for (const a of ls) {
    const dur = seconds(a.attrs.dur)
    const b = seconds(a.attrs.begin)
    expect(b, `begin ${a.attrs.begin} of a ${a.attrs.dur} loop`).toBeLessThanOrEqual(0)
    expect(b, `begin ${a.attrs.begin} of a ${a.attrs.dur} loop`).toBeGreaterThan(-dur - 0.01)
  }
})

test('bubble: wide characters (CJK, emoji) count double', () => {
  const widthOf = (label: string) => {
    const svg = svgOf({ desks: [mk('n', 'busy', NOW - 1000, { label })], lead: LEAD, now: NOW, epoch: NOW, freshMs: FRESH })
    const found = bubbles(svg, label)
    expect(found.length, `one bubble for "${label}"`).toBe(1)
    return bubbleRect(svg, found[0]!).width
  }
  const latin = widthOf('abcdefghij')
  expect(widthOf('漢字漢字漢字漢字漢字')).toBeGreaterThanOrEqual(latin * 1.5)
  expect(widthOf('🚀📦🚀📦🚀📦🚀📦🚀📦')).toBeGreaterThanOrEqual(latin * 1.5)
})

test('sprites: at any step the character loop runs through all 24 frames in 24 × 0.12 s', () => {
  const desk = mk('a', 'busy', NOW - 60_000, { kind: 'claude', role: 'creation', color: '#e0a84e' })
  for (const step of [2, 3, 4]) {
    const svg = officeSvg({ desks: [desk], lead: LEAD, now: NOW, epoch: NOW, freshMs: FRESH, step } as unknown as Scene)
    const defined = new Set([...svg.matchAll(/<g id="f\d+">([\s\S]*?)<\/g>/g)].map(m => m[1]!))
    const want = spriteFrames('claude', 'creation', 'busy', '#e0a84e', Math.floor(24 / step), step)
    want.forEach((f, i) => expect(defined.has(f), `step ${step}: frame ${i * step} of the loop is drawn`).toBe(true))
    const cycles = anims(svg).filter(a => a.attrs.attributeName === 'visibility')
    expect(cycles.length).toBeGreaterThanOrEqual(1)
    for (const a of cycles) near(seconds(a.attrs.dur), 24 * 0.12, 0.011)
  }
})
// ---- 8. settling: a scene reloaded later must not replay what already happened ----------------

type Within = { svg: string; hidden: number; shown: number; settleAt: number }
/** officeWithin with its `settleAt`: when everything the scene plans (arrivals, round, departures) is over. */
function within(desks: Desk[], now: number, lead: Mood = 'rest', extra: Record<string, unknown> = {}): Within {
  const w = officeWithin({ desks, lead: { mood: lead, color: '#d97757' }, now, epoch: 0, freshMs: FRESH, ...extra } as unknown as Scene) as Within
  if (typeof w.settleAt !== 'number') throw new Error('officeWithin must return settleAt: number')
  return w
}

/** One-off animations still to play in a scene: a positive begin, or a frozen one not over yet. */
function pending(svg: string): string[] {
  return anims(svg)
    .filter(a => a.attrs.repeatCount !== 'indefinite')
    .filter(a => seconds(a.attrs.begin) > 0.0001 || seconds(a.attrs.begin) + seconds(a.attrs.dur) > 0.0001)
    .map(a => `<${a.tag} begin="${a.attrs.begin ?? ''}" dur="${a.attrs.dur ?? ''}">`)
}

test('settle: officeWithin says when an arrival (window, round, bubble) is over', () => {
  const n = mk('n', 'busy', NOW - 1000, { name: 'Newbie', label: 'Arrivée', seat: 0 })
  const w = within([n], NOW)
  const r = round(w.svg, NOW)
  expect(r, 'the lead walks to the newcomer').toBeTruthy()
  const bub = bubbleTimes(w.svg, ['Arrivée'], NOW)[0]!
  const expected = Math.max(n.arrivedAt + FRESH, NOW + (r!.at + r!.dur) * 1000, NOW + (bub.at + bub.dur) * 1000)
  expect(Math.abs(w.settleAt - expected), `settleAt ${w.settleAt - NOW} ms from now, expected ${expected - NOW}`).toBeLessThanOrEqual(15)
  // Built once it is all over: no one-off animation left to play; the agent sits, the lead is home.
  const after = within([n], w.settleAt + 1)
  expect(pending(after.svg)).toEqual([])
  expect(after.svg).toContain('Newbie')
  expect(drops(after.svg)).toHaveLength(0)
  expect(round(after.svg, w.settleAt + 1)).toBeUndefined()
})

test('settle: officeWithin says when a departure is over, and the scene built then is still', () => {
  const after = constant('LEAVE_AFTER_MS')
  const anim = constant('LEAVE_ANIM_MS')
  const g = mk('g', 'rest', NOW - 120_000, { name: 'Haiku', label: 'Partir', seat: 0, endedAt: NOW - 100 })
  const stay = mk('s', 'busy', NOW - 120_000, { name: 'Opus', seat: 1 })
  const w = within([g, stay], NOW)
  expect(w.settleAt).toBe(g.endedAt! + after + anim)
  const later = within([g, stay], w.settleAt + 1)
  expect(pending(later.svg)).toEqual([])
  expect(later.svg).not.toContain('Haiku')
  expect(marks(later.svg)).toContain('desk-empty')
  expect(later.svg).toContain('Opus')
})

test('settle: with an arrival and a departure, the later of the two; with nothing planned, not after now', () => {
  const after = constant('LEAVE_AFTER_MS')
  const anim = constant('LEAVE_ANIM_MS')
  const n = mk('n', 'busy', NOW - 1000, { name: 'Newbie', label: 'Arrivée', seat: 0 })
  const g = mk('g', 'rest', NOW - 120_000, { name: 'Haiku', label: 'Partir', seat: 1, endedAt: NOW - 100 })
  const both = within([n, g], NOW)
  expect(both.settleAt).toBe(Math.max(within([n], NOW).settleAt, g.endedAt! + after + anim))
  expect(pending(within([n, g], both.settleAt + 1).svg)).toEqual([])
  const quiet = within([mk('o', 'busy', NOW - 60_000, { seat: 0 }), mk('p', 'rest', NOW - 60_000, { seat: 1 })], NOW)
  expect(quiet.settleAt).toBeLessThanOrEqual(NOW)
  expect(pending(quiet.svg)).toEqual([])
})

test('settle: the reviewer scenario rebuilds on the 10 key changes plus one settling per quiet spell', () => {
  // The rule register.tsx follows: rebuild when the key changes, or once when now passes settleAt.
  const T = NOW
  const runs = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, start: T + i * 300, end: T + 15_000 + i * 300 }))
  let cache: { key: string; builtAt: number; settleAt: number } | null = null
  const rebuilds: number[] = []
  for (let now = T; now < T + 60_000; now += 120) {
    const desks = runs
      .filter(r => r.start <= now)
      .map((r, i) => mk(r.id, now < r.end ? 'busy' : 'rest', r.start, { label: 'x', seat: i, ...(now < r.end ? {} : { endedAt: r.end }) }))
    const key = officeKey(desks, 'busy', now, FRESH)
    if (!cache || cache.key !== key || (now >= cache.settleAt && cache.builtAt < cache.settleAt)) {
      cache = { key, builtAt: now, settleAt: within(desks, now, 'busy').settleAt }
      rebuilds.push((now - T) / 1000)
    }
  }
  // Arrivals 0–1.2 s, ends 15–16.2 s: two quiet spells to settle (after the round, after the departures).
  expect(rebuilds.length, `rebuilds at s: ${rebuilds.join(' ')}`).toBeLessThanOrEqual(12)
  expect(cache!.builtAt).toBeGreaterThanOrEqual(cache!.settleAt)
})

// ---- 9. the room keeps its seats and their decor ------------------------------------------------

test('seats: the scene draws desks up to maxSeat, even when the runs at the end left the history', () => {
  const B = mk('B', 'busy', NOW - 100_000, { name: 'Bname', seat: 1 })
  const svg = officeSvg({ desks: [B], lead: LEAD, now: NOW, epoch: 0, freshMs: FRESH, maxSeat: 3 } as unknown as Scene)
  const grid = officeSvg({
    desks: Array.from({ length: 4 }, (_, i) => mk(`s${i}`, 'busy', NOW - 300_000 + i, { name: `S${i}`, seat: i })),
    lead: LEAD,
    now: NOW,
    epoch: 0,
    freshMs: FRESH,
  } as unknown as Scene)
  expect(marks(svg).filter(t => t === 'desk-empty')).toHaveLength(3)
  expect(tagAt(svg, 'Bname')).toEqual(tagAt(grid, 'S1'))
  const box = (s: string) => /viewBox="([^"]+)"/.exec(s)?.[1]
  expect(box(svg)).toBe(box(grid))
  // officeWithin passes it on, and counts those seats as drawn.
  const w = officeWithin({ desks: [B], lead: LEAD, now: NOW, epoch: 0, freshMs: FRESH, maxSeat: 3 } as unknown as Scene)
  expect(marks(w.svg).filter(t => t === 'desk-empty')).toHaveLength(3)
  expect(w.shown).toBe(4)
})

test('seats: an empty desk keeps the decor of its last agent, from the seat table, once that agent left the history', () => {
  const role = 'recherche' as const
  const last = mk('agent-xyz-42', 'rest', NOW - 300_000, { role, seat: 0 })
  // While the agent is listed (it sat there), then after its run left the history.
  const listed = officeSvg({ desks: [last], lead: LEAD, now: NOW, epoch: 0, freshMs: FRESH } as unknown as Scene)
  // The desk's own pieces only (its role decor and its object), not the desk-empty marker.
  const pieces = (svg: string) => [...drawn(svg, 'desk-deco-'), ...drawn(svg, 'desk-item-')]
  const want = pieces(listed)
  expect(want).toContain(`desk-deco-${role}`)
  expect(want.filter(t => t.startsWith('desk-item-'))).toHaveLength(1)
  const table = officeSvg({
    desks: [],
    lead: LEAD,
    now: NOW,
    epoch: 0,
    freshMs: FRESH,
    maxSeat: 0,
    seats: [{ role, itemKey: last.id }],
  } as unknown as Scene)
  expect(marks(table).filter(t => t === 'desk-empty')).toHaveLength(1)
  expect(pieces(table)).toEqual(want)
})

// ---- 10. rounds one after the other -----------------------------------------------------

/** Every round of the lead in a scene (from home back home), in order. */
function rounds(svg: string, builtAt: number) {
  return anims(svg)
    .filter(a => {
      if (a.tag !== 'animateTransform' || a.attrs.fill !== 'freeze' || !a.attrs.values) return false
      const pts = a.attrs.values.split(';').map(p => p.trim())
      return pts.length >= 3 && /^0[ ,]0$/.test(pts[0]!) && /^0[ ,]0$/.test(pts[pts.length - 1]!)
    })
    .map(a => ({ at: seconds(a.attrs.begin) + (builtAt - NOW) / 1000, dur: seconds(a.attrs.dur), values: a.attrs.values!, keyTimes: a.attrs.keyTimes ?? '' }))
    .sort((a, b) => a.at - b.at)
}

/** How long the lead stands at each stop of a round (consecutive equal points away from home), in s. */
function pauses(r: { dur: number; values: string; keyTimes: string }): number[] {
  const pts = r.values.split(';').map(p => p.trim())
  const ks = r.keyTimes.split(';').map(Number)
  const out: number[] = []
  for (let j = 0; j + 1 < pts.length; j++) if (pts[j] === pts[j + 1] && !/^0[ ,]0$/.test(pts[j]!)) out.push((ks[j + 1]! - ks[j]!) * r.dur)
  return out
}

test('round: each stop lasts at least 250 ms, even for the 8th newcomer', () => {
  const desks = burst(8)
  const svg = svgOf({ desks, lead: { mood: 'busy', color: '#d97757' }, now: NOW + 350, epoch: 0, freshMs: FRESH })
  const rs = rounds(svg, NOW + 350)
  expect(rs.length).toBe(1)
  const ps = pauses(rs[0]!)
  expect(ps.length, 'a stop at each of the 8 desks').toBeGreaterThanOrEqual(8)
  ps.forEach((p, i) => expect(p, `stop ${i}: ${p.toFixed(3)} s`).toBeGreaterThanOrEqual(0.245))
})

test('round: a second burst 10 s later waits for the round in progress to end; the lead never jumps', () => {
  const lead = { mood: 'busy' as Mood, color: '#d97757' }
  const first = burst(8)
  const second = Array.from({ length: 4 }, (_, i) => mk(`c${i}`, 'busy', NOW + 10_000 + i * 50, { label: `Suite ${i}`, name: `Suite ${i}`, seat: 8 + i }))
  const r1 = rounds(svgOf({ desks: first, lead, now: NOW + 350, epoch: 0, freshMs: FRESH }), NOW + 350)[0]!
  const builtAt = NOW + 10_200
  const svg = svgOf({ desks: [...first, ...second], lead, now: builtAt, epoch: 0, freshMs: FRESH })
  const rs = rounds(svg, builtAt)
  // Rounds never overlap: one starts at the earliest when the one before ends.
  for (let k = 1; k < rs.length; k++) expect(rs[k]!.at, `round ${k} starts after round ${k - 1} ends`).toBeGreaterThanOrEqual(rs[k - 1]!.at + rs[k - 1]!.dur - 0.011)
  // The first round, if still going, goes on unchanged.
  if (r1.at + r1.dur > (builtAt - NOW) / 1000) {
    const same = rs.find(r => Math.abs(r.at - r1.at) <= 0.011)
    expect(same, 'the first round is still in the scene').toBeTruthy()
    expect(same!.values).toBe(r1.values)
    expect(same!.dur).toBe(r1.dur)
  }
  // The second burst is handed over after the first round, each bubble shown at least 1 s, each stop 250 ms or more.
  const times = bubbleTimes(svg, second.map(d => d.label), builtAt)
  times.forEach((t, i) => {
    expect(t, `a bubble for Suite ${i}`).toBeTruthy()
    expect(t!.at, `Suite ${i} handed over after the first round`).toBeGreaterThanOrEqual(r1.at + r1.dur - 0.011)
    expect(t!.dur).toBeGreaterThanOrEqual(1)
  })
  for (const r of [r1, ...rs]) for (const p of pauses(r)) expect(p, `a stop of ${p.toFixed(3)} s`).toBeGreaterThanOrEqual(0.245)
})