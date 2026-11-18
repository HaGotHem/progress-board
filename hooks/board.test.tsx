import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'progress-board',
  component: 'Pane',
  requestId: 'progress-board',
  props: {
    title: 'Avancement',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('plan tasks and a Gemini Argon run fill the bars', async ($, on) => {
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('clock.now', () => ({ value: 1000 }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [
      { content: 'Écrire les tests', status: 'in_progress' },
      { content: 'Implémenter', status: 'pending' },
    ],
    scope: 'first_task',
  })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })
  await $.tool.call({
    tool: 'Bash',
    command: 'ask-gemini --task review --model gemini-4-argon-high "relis"',
    description: 'Revue Gemini',
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const text = (await ui.find({ type: 'Box' }))?.text ?? ''
    // 1 task done + 0.5 in progress + 1 Gemini run done, of 3 units.
    expect(text).toMatch(/Avancement général/)
    expect(text).toMatch(/2\.5\/3/)
    expect(text).toMatch(/Revue Gemini · fini/)
    expect(text).toMatch(/Écrire les tests/)
    // The Gemini reviewer is a checker, and free once done; the lead is drawn too.
    expect(text).toMatch(/Gemini Argon \(high\) · vérification · libre/)
    expect(text).toMatch(/Claude · orchestrateur/)
    await ui.unmount()
  }
})

test('a MODEL= prefix is not taken for the model: ask-gemini resets it', async ($, on) => {
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {}, text: '[gemini: agy gemini-3.8-flash-low]\nok' }))
  on('clock.now', () => ({ value: 1000 }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'MODEL=gemini-4-argon-high ask-gemini --task read "x"', description: 'Résumé' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const text = (await ui.find({ type: 'Box' }))?.text ?? ''
  expect(text).toMatch(/Gemini Flash \(low\) · recherche/)
  expect(text).not.toMatch(/Argon/)
  expect(text).toMatch(/recherche/)
  await ui.unmount()
})

test('an empty board says so', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Rien en cours/ }))?.text).toMatch(/Rien en cours/)
  await ui.unmount()
})

test('the office view draws an SVG scene on desktop and a note on the terminal', async ($, on) => {
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {}, text: '[gemini: agy gemini-4-argon-low]\nok' }))
  on('clock.now', () => ({ value: 5000 }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ask-gemini --task review --model gemini-4-argon-low "x"', description: 'Revue' })

  const office = { ...PANE, requestId: 'progress-office', props: { ...PANE.props, title: 'Bureau' } }
  const desk = await $.ui.mount({ ...office, surface: 'desktop' })
  const svg = await desk.find({ type: 'Svg' })
  expect(svg).toBeTruthy()
  const source = String((svg as { props?: { source?: string } })?.props?.source ?? '')
  expect(source).toMatch(/BUREAU/)
  expect(source).toMatch(/Gemini Argon/)
  expect(source.length).toBeLessThan(131072)
  await desk.unmount()

  const term = await $.ui.mount({ ...office, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: /app de bureau/ }))?.text).toMatch(/app de bureau/)
  await term.unmount()
})

// ---- the office view over time ------------------------------------------------------------

const OFFICE_PANE = { ...PANE, requestId: 'progress-office', props: { ...PANE.props, title: 'Bureau' } }

/** The office scene's SVG source as the desktop draws it now. */
async function officeSource($: any): Promise<string> {
  const ui = await $.ui.mount({ ...OFFICE_PANE, surface: 'desktop' })
  const svg = await ui.find({ type: 'Svg' })
  const source = String((svg as { props?: { source?: string } })?.props?.source ?? '')
  await ui.unmount()
  return source
}

/** The begin, in seconds, of the scene's 40 s cloud loop (absent = 0). */
function cloudBegin(svg: string): number {
  const tag = /<animateTransform\b[^>]*\bdur="40s"[^>]*>/.exec(svg)?.[0]
  expect(tag, 'the cloud loop (dur="40s")').toBeTruthy()
  const begin = /\bbegin="(-?[\d.]+)s"/.exec(tag!)?.[1]
  return begin ? Number(begin) : 0
}

function hooks(on: any, output = 'ok') {
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {}, text: output }))
}

test('office: an agent going from happy to rest does not rebuild the scene', async ($, on) => {
  hooks(on)
  const clock = mock.clock(on, { now: 1000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // A background run keeps the board moving; a second run finishes at once.
  await $.tool.call({ tool: 'Bash', command: 'ask-gemini --task read "a"', description: 'Lecture longue', run_in_background: true })
  await $.tool.call({ tool: 'Bash', command: 'ask-gemini --task review "b"', description: 'Revue' })
  await clock.advance(1000)
  const first = await officeSource($) // the review just ended: happy
  await clock.advance(5000)
  const second = await officeSource($) // 6 s later: rest; both still in their arrival window
  expect(first).toMatch(/BUREAU/)
  expect(second === first, 'the office SVG source is the same string (no rebuild on happy → rest)').toBe(true)
})

test('office: a rebuilt scene resumes its loops where they were', async ($, on) => {
  hooks(on)
  const clock = mock.clock(on, { now: 1000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ask-gemini --task read "a"', description: 'Lecture longue', run_in_background: true })
  await clock.advance(1200)
  const first = await officeSource($)
  await clock.advance(3000)
  // A new desk: the scene is rebuilt 3 s later, its cloud 3 s further along.
  await $.tool.call({ tool: 'Bash', command: 'ask-gemini --task review "b"', description: 'Revue' })
  await clock.settle()
  const second = await officeSource($)
  expect(second !== first, 'the scene was rebuilt for the new desk').toBe(true)
  const d = (((cloudBegin(first) - 3 - cloudBegin(second)) % 40) + 40) % 40
  expect(Math.min(d, 40 - d), `cloud begin ${cloudBegin(first)}s then ${cloudBegin(second)}s`).toBeLessThan(0.25)
})

const unxml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

/** Where the name tag showing exactly `name` is drawn. */
function tagAt(svg: string, name: string): { x: number; y: number } {
  const found = [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].filter(m => unxml(m[2] ?? '') === name)
  expect(found.length, `one name tag "${name}"`).toBe(1)
  const a = found[0]![1] ?? ''
  return { x: Number(/\bx="(-?[\d.]+)"/.exec(a)?.[1]), y: Number(/\by="(-?[\d.]+)"/.exec(a)?.[1]) }
}

/** The opacity-to-0 freeze animations that a <g> enclosing `at` holds as first children: [begin, end] in s. */
function fadesAround(svg: string, at: number): [number, number][] {
  const tags = /<g\b[^>]*?(\/?)>|<\/g>/g
  const opens: { at: number; len: number }[] = []
  for (let m = tags.exec(svg); m && m.index < at; m = tags.exec(svg)) {
    if (m[0].startsWith('</g')) opens.pop()
    else if (m[1] !== '/') opens.push({ at: m.index, len: m[0].length })
  }
  const out: [number, number][] = []
  for (const o of opens) {
    const run = /^(?:\s*<(?:animateTransform|animate|set)\b[^>]*?\/>)*/.exec(svg.slice(o.at + o.len))?.[0] ?? ''
    for (const m of run.matchAll(/<(?:animate|set)\b([^>]*?)\/>/g)) {
      const a = m[1] ?? ''
      const attr = (k: string) => new RegExp(`\\b${k}="([^"]*)"`).exec(a)?.[1]
      if (attr('attributeName') !== 'opacity' || attr('fill') !== 'freeze') continue
      if (attr('to') !== '0' && (attr('values') ?? '').split(';').pop()?.trim() !== '0') continue
      const begin = Number((attr('begin') ?? '0s').replace(/s$/, ''))
      out.push([begin, begin + Number((attr('dur') ?? '0s').replace(/s$/, ''))])
    }
  }
  return out
}

test('office: a finished agent leaves the open office while it stays mounted, and keeps its row on the board', async ($, on) => {
  hooks(on, '[gemini: agy gemini-4-argon-low]\nok')
  const clock = mock.clock(on, { now: 1000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // Mounted once, read as the surface would: the source it holds now, and when it was loaded.
  const ui = await $.ui.mount({ ...OFFICE_PANE, surface: 'desktop' })
  const read = async () => String(((await ui.find({ type: 'Svg' })) as { props?: { source?: string } } | undefined)?.props?.source ?? '')
  let source = await read()
  let loadedAt = clock.now()
  const tick = async (ms: number) => {
    for (let t = 0; t < ms; t += 120) {
      await clock.advance(120)
      const s = await read()
      if (s !== source) {
        source = s
        loadedAt = clock.now()
      }
    }
  }
  await $.tool.call({ tool: 'Bash', command: 'ask-gemini --task review --model gemini-4-argon-low "x"', description: 'Revue' })
  await tick(2000)
  expect(source, 'the agent shows up in the open office').toMatch(/Gemini Argon/)
  // Well past LEAVE_AFTER_MS + LEAVE_ANIM_MS, with nothing else going on.
  await tick(60_000)
  const elapsed = (clock.now() - loadedAt) / 1000
  expect(source).toMatch(/BUREAU/)
  // The desk stays in the room, empty: drawn so, or the agent's tag has faded out by now.
  const at = source.indexOf('>Gemini Argon (low)<')
  if (at >= 0) {
    const fades = fadesAround(source, at)
    expect(fades.length, 'the name tag of a departed agent fades out').toBeGreaterThanOrEqual(1)
    expect(Math.min(...fades.map(f => f[1])), `faded out ${elapsed.toFixed(1)} s after the scene loaded`).toBeLessThanOrEqual(elapsed)
    expect(source, 'it left with its box').toMatch(/\b(?:class|id)="[^"]*carton/)
  } else {
    expect(source).not.toMatch(/Gemini Argon/)
    expect(source).toMatch(/\b(?:class|id)="[^"]*\bdesk-empty\b/)
  }
  // Nobody at work, and the one who left is not counted as free.
  const count = (await ui.find({ type: 'Text', text: /au travail/ }))?.text ?? ''
  expect(count).toMatch(/\b0 agents? au travail/)
  expect(count).toMatch(/\b0 libres?\b/)
  await ui.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const text = (await pane.find({ type: 'Box' }))?.text ?? ''
  expect(text).toMatch(/Revue · fini/)
  expect(text).toMatch(/Gemini Argon \(low\)/)
  await pane.unmount()
})

test('office: seats are kept when the oldest run drops out of the 30-run history', async ($, on) => {
  hooks(on)
  mock.clock(on, { now: 1000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const run = (model: string, description: string, background = true) =>
    $.tool.call({ tool: 'Bash', command: `ask-gemini --task read --model ${model} "x"`, description, run_in_background: background })
  await run('gemini-4-argon-low', 'A')
  await run('gemini-4-hydrogen-high', 'B')
  await run('gemini-4-argon-high', 'C')
  for (let i = 0; i < 27; i++) await run('gemini-3.8-flash-low', `F${i}`, false)
  const before = await officeSource($)
  expect(before).toContain('Gemini Argon (low)')
  const b = tagAt(before, 'Gemini Hydrogen (high)')
  const c = tagAt(before, 'Gemini Argon (high)')
  // One more run: A, the oldest, leaves the history (and the office draws without it).
  await run('gemini-3.8-flash-low', 'F27', false)
  const after = await officeSource($)
  expect(after).not.toContain('Gemini Argon (low)')
  expect(tagAt(after, 'Gemini Hydrogen (high)'), 'B keeps its desk').toEqual(b)
  expect(tagAt(after, 'Gemini Argon (high)'), 'C keeps its desk').toEqual(c)
  // A's desk is still there, empty.
  expect(after).toMatch(/\b(?:class|id)="[^"]*\bdesk-empty\b/)
})
/** One-off animations a source still has to play once loaded: a positive begin, or a frozen one not over. */
function pendingIn(svg: string): string[] {
  const out: string[] = []
  for (const m of svg.matchAll(/<(animateTransform|animateMotion|animate|set)\b([^>]*?)\/?>/g)) {
    const a = m[2] ?? ''
    if (/repeatCount="indefinite"/.test(a)) continue
    const num = (k: string) => {
      const v = new RegExp(`\\b${k}="(-?[\\d.]+)(ms|s)?"`).exec(a)
      return v ? Number(v[1]) / (v[2] === 'ms' ? 1000 : 1) : 0
    }
    if (num('begin') > 0.0001 || num('begin') + num('dur') > 0.0001) out.push(`<${m[1]}${a}>`)
  }
  return out
}

test('office: reopened a minute after an agent finished, the scene shows the end, without replaying it', async ($, on) => {
  hooks(on, '[gemini: agy gemini-4-argon-low]\nok')
  const clock = mock.clock(on, { now: 1000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ask-gemini --task review --model gemini-4-argon-low "x"', description: 'Revue' })
  const atEnd = await officeSource($) // built when it finished: its departure is planned
  expect(atEnd).toMatch(/Gemini Argon/)
  await clock.advance(60_000)
  const reopened = await officeSource($)
  expect(reopened !== atEnd, 'rebuilt once everything planned is over').toBe(true)
  expect(pendingIn(reopened), 'nothing left to play').toEqual([])
  expect(reopened).not.toMatch(/Gemini Argon/)
  expect(reopened).toMatch(/\b(?:class|id)="[^"]*\bdesk-empty\b/)
})

test('office: reopened while an agent has worked for 5 min, its desk does not drop again nor does it walk in', async ($, on) => {
  hooks(on)
  const clock = mock.clock(on, { now: 1000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ask-gemini --task read --model gemini-4-argon-low "x"', description: 'Long', run_in_background: true })
  const atArrival = await officeSource($)
  expect(atArrival).toMatch(/Gemini Argon/)
  await clock.advance(300_000)
  const reopened = await officeSource($)
  expect(reopened).toMatch(/Gemini Argon/)
  expect(pendingIn(reopened), 'no arrival left to play').toEqual([])
  expect(reopened, 'no walk in through the door').not.toMatch(/<animateTransform\b[^>]*dur="1\.8s"[^>]*fill="freeze"/)
  expect(reopened, 'no desk drop').not.toMatch(/values="0,-70/)
})

test('office: the last seats and their decor stay when their runs leave the history', async ($, on) => {
  hooks(on)
  const clock = mock.clock(on, { now: 1000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const run = (task: string, description: string) =>
    $.tool.call({ tool: 'Bash', command: `ask-gemini --task ${task} --model gemini-3.8-flash-low "x"`, description })
  // Seat 0: a checker; seat 1: a researcher. Both done, both walk out.
  await run('review', 'X')
  await run('read', 'Y')
  await clock.advance(30_000)
  const before = await officeSource($)
  /** The drawn decor of the empty desk that holds `token`. */
  const emptyWith = (svg: string, token: string): string[] => {
    for (const m of svg.matchAll(/<g class="desk-empty">([\s\S]*?)<\/g>/g)) {
      const uses = [...m[1]!.matchAll(/href="#(desk-[^"]+)"/g)].map(u => u[1]!).sort()
      if (uses.includes(token)) return uses
    }
    return []
  }
  const seat1 = emptyWith(before, 'desk-deco-recherche')
  expect(seat1, 'the researcher left an empty desk with its decor').toContain('desk-deco-recherche')
  const box = (s: string) => /viewBox="([^"]+)"/.exec(s)?.[1]
  // 30 more agents, one after the other, each on seat 0 once the one before has left: X then Y leave the history.
  for (let i = 0; i < 30; i++) {
    await run('code', `F${i}`)
    await clock.advance(25_000)
  }
  const after = await officeSource($)
  expect(after).not.toMatch(/desk-deco-verification/) // seat 0 now has the coders' decor
  expect(emptyWith(after, 'desk-deco-recherche'), 'seat 1 is still drawn, with the researcher\'s decor and object').toEqual(seat1)
  expect(box(after)).toBe(box(before))
})