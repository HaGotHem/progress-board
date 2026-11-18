import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Anim, Board, Mood, Run, Task, TaskStatus } from '../types'
import { ROLE_LABEL, roleOf, sprite, spriteSvg, SPRITE_LINES, SPRITE_WIDTH } from './sprites'
import { assignSeat, LEAVE_AFTER_MS, LEAVE_ANIM_MS, officeKey, officeWithin, sceneSize } from './office'
import type { Desk } from './office'

const PANE = 'progress-board'
const TITLE = 'Avancement'
const OFFICE = 'progress-office'
const OFFICE_TITLE = 'Bureau'
/** How long a new agent's arrival (desk, walk-in, the lead's visit) is animated. */
const FRESH_MS = 10_000
const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const WRAP_TOOL = 'mcp__ccd_turn__wrap_up'
const MAX_RUNS = 30
const FRAME_MS = 120
/** How long a finished bar keeps its flash. */
const FLASH_MS = 1500
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// Change the tag when Board's fields change: an earlier version's value is then read as empty.
const board = atom({ plugin: 'progress-board', key: 'board' } as const, { tasks: [], runs: [] } as Board, {
  shape: 'board-1',
})
const anim = atom({ plugin: 'progress-board', key: 'anim' } as const, { frame: 0, now: 0, shown: 0 } as Anim, {
  shape: 'anim-1',
})

// The animation timer: module state on purpose, a reload drops the old timer and session.start starts a new one.
let ticker: { cancel: () => void } | null = null
// The office SVG for the last scene key: rebuilt only when something in the scene changes.
let officeCache: { key: string; svg: string; hidden: number; shown: number; builtAt: number; settleAt: number } | null = null
// The origin of the office's looping animations. A constant: the scene wraps each loop into its own
// duration, so a rebuilt scene (or a reloaded mod) finds the loops where they were.
const OFFICE_EPOCH = 0

// Built SVGs by kind/role/mood/color: a redraw every frame reuses the same string.
const svgCache = new Map<string, string>()
function svgOf(...args: Parameters<typeof spriteSvg>): string {
  const key = args.join('|')
  let svg = svgCache.get(key)
  if (!svg) {
    svg = spriteSvg(...args)
    svgCache.set(key, svg)
  }
  return svg
}

/** Display name and bar color for a model id or alias. */
function family(model: string): { name: string; color: string } {
  const m = model.toLowerCase()
  const effort = /-(low|medium|high|xhigh)$/.exec(m)?.[1]
  const tag = effort ? ` (${effort})` : ''
  if (m.includes('hydrogen')) return { name: `Gemini Hydrogen${tag}`, color: '#4f8df7' }
  if (m.includes('argon')) return { name: `Gemini Argon${tag}`, color: '#9b72f2' }
  if (m.includes('gemini') || m.includes('flash')) return { name: `Gemini Flash${tag}`, color: '#2bb3c0' }
  if (m.includes('opus')) return { name: 'Opus', color: '#d97757' }
  if (m.includes('sonnet')) return { name: 'Sonnet', color: '#e0a84e' }
  if (m.includes('haiku')) return { name: 'Haiku', color: '#7fb069' }
  if (m.includes('fable')) return { name: 'Fable', color: '#c76b98' }
  return { name: model, color: 'suggestion' }
}

/** Which Gemini model an ask-gemini / agy command line asks for (ask-gemini resets a MODEL= prefix: only --model counts). */
function geminiModel(command: string): string {
  const explicit = /--model[= ]["']?([\w.-]+)/.exec(command)?.[1]
  if (explicit) return explicit
  const effort = /--effort[= ](\w+)/.exec(command)?.[1]
  return `gemini-3.8-flash-${effort ?? 'low'}`
}

/** The model a finished ask-gemini run names on its first line: `[gemini: agy <model>]`. */
function modelFromOutput(text: string): string | undefined {
  return /\[gemini: agy ([\w.-]+)\]/.exec(text)?.[1]
}

function isGeminiRun(command: string): boolean {
  if (!/\b(ask-gemini|agy)\b/.test(command)) return false
  // Bookkeeping calls of the wrapper, not a model run.
  return !/ask-gemini\s+--(status|reset|discard)\b|agy\s+(models|--version|--help)\b/.test(command)
}

function seconds(run: Run, now?: number): string {
  const s = Math.max(0, Math.round(((run.endedAt ?? now ?? run.startedAt) - run.startedAt) / 1000))
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`
}

function setPlanStatus(tasks: Task[], index: number, status: TaskStatus): Task[] {
  return tasks.map(t => (t.id === `plan-${index}` ? { ...t, status } : t))
}

/** A run as the seat assignment sees it: working, or finished at some time. */
const seatView = (r: Run) => ({ seat: r.seat, mood: isLive(r) ? ('busy' as const) : ('rest' as const), endedAt: isLive(r) ? undefined : r.endedAt })

/** The seat table of a board: what each seat last held, and the highest seat ever handed out. */
function seatTable(b: Board, runs: Run[]): { seats: NonNullable<Board['seats']>; maxSeat: number } {
  // A board stored by an earlier version has neither: start from the runs it still lists.
  const seats = [...(b.seats ?? [])]
  let maxSeat = b.maxSeat ?? -1
  for (const r of [...runs].sort((x, y) => x.startedAt - y.startedAt)) {
    if (r.seat == null) continue
    if (!b.seats || !seats[r.seat]) seats[r.seat] = { role: r.role ?? 'generaliste', itemKey: r.id }
    maxSeat = Math.max(maxSeat, r.seat)
  }
  for (let i = 0; i < seats.length; i++) seats[i] ??= null
  return { seats, maxSeat }
}

async function addRun($: EngineInterface, run: Run) {
  await update($, board, b => {
    // The seat is given once, here, and kept: the history's limit below only drops the oldest runs,
    // which leaves their desks empty instead of moving anyone. Runs an earlier version stored with
    // no seat get theirs first, in order of arrival.
    const placed: ReturnType<typeof seatView>[] = []
    const runs = b.runs.map(r => {
      const seated = r.seat == null ? { ...r, seat: assignSeat(placed, r.startedAt) } : r
      placed.push(seatView(seated))
      return seated
    })
    const seated = { ...run, seat: assignSeat(placed, run.startedAt) }
    // The room remembers its seats: the highest ever handed out, and what the last agent of each
    // left on its desk, so a desk whose run left the history is still drawn, as it was.
    const known = seatTable(b, runs)
    const seats = [...known.seats]
    while (seats.length <= seated.seat) seats.push(null)
    seats[seated.seat] = { role: seated.role ?? 'generaliste', itemKey: seated.id }
    return { ...b, runs: [...runs, seated].slice(-MAX_RUNS), seats, maxSeat: Math.max(known.maxSeat, seated.seat) }
  })
  ensureTicker($)
}

async function finishRun($: EngineInterface, id: string, status: Run['status'], model?: string) {
  const now = await $.clock.now()
  await update($, board, b => ({
    ...b,
    runs: b.runs.map(r =>
      r.id === id && isLive(r) ? { ...r, status, endedAt: now, model: model ?? r.model } : r,
    ),
  }))
  ensureTicker($)
}

/** Background Gemini calls no longer listed as running are finished. */
async function settleBackground($: EngineInterface, running: { command?: string }[] | undefined) {
  if (!running) return
  const now = await $.clock.now()
  const live = running.map(t => t.command ?? '')
  await update($, board, b => ({
    ...b,
    runs: b.runs.map(r =>
      r.status === 'background' && !live.some(c => c && r.command && (c.includes(r.command) || r.command.includes(c)))
        ? { ...r, status: 'done' as const, endedAt: now }
        : r,
    ),
  }))
  ensureTicker($)
}

function overall(b: Board): { value: number; max: number } {
  const taskDone = b.tasks.reduce((n, t) => n + (t.status === 'completed' ? 1 : t.status === 'in_progress' ? 0.5 : 0), 0)
  const runDone = b.runs.filter(r => r.status === 'done' || r.status === 'error').length
  return { value: taskDone + runDone, max: b.tasks.length + b.runs.length }
}

const isLive = (r: Run) => r.status === 'running' || r.status === 'background'

/** Runs the animation while something moves; stops itself once all is still. */
function ensureTicker($: EngineInterface) {
  if (ticker) return
  try {
    ticker = $.clock.every(FRAME_MS, () => {
    void (async () => {
      const b = await read($, board)
      const now = await $.clock.now()
      const all = overall(b)
      const target = all.max ? all.value / all.max : 0
      const a = await read($, anim)
      const gap = target - a.shown
      const shown = Math.abs(gap) < 0.004 ? target : a.shown + gap * 0.22
      const moving =
        b.leadBusy === true ||
        b.runs.some(isLive) ||
        b.tasks.some(t => t.status === 'in_progress') ||
        b.runs.some(r => r.endedAt != null && now - r.endedAt < FLASH_MS) ||
        // The open office still has something planned (an arrival, a departure): keep ticking until
        // it is all over, so it is redrawn once, still.
        (officeCache != null && now < officeCache.settleAt) ||
        shown !== target
      await update($, anim, x => ({ frame: x.frame + 1, now, shown }))
      if (!moving && ticker) {
        ticker.cancel()
        ticker = null
      }
    })().catch(() => {
      ticker?.cancel()
      ticker = null
    })
  })
  } catch {
    // No timer here (a host without clock.every): the bars are drawn still.
    ticker = null
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'progress',
      description: 'Ouvre le panneau d’avancement (/progress bureau : vue bureau ; /progress reset : vider)',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    ensureTicker($)
    return next(e)
  })

  on('command.run', { command: 'progress' }, async ($, e) => {
    if (/\breset\b/.test(String((e as { args?: string }).args ?? ''))) {
      await update($, board, () => ({ tasks: [], runs: [] }))
      await update($, anim, a => ({ ...a, shown: 0 }))
      return { text: 'Panneau d’avancement vidé.' }
    }
    if (/bureau|office/.test(String((e as { args?: string }).args ?? ''))) {
      await $.ui.open({ id: OFFICE, title: OFFICE_TITLE })
      return { text: 'Vue bureau ouverte.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Panneau d’avancement ouvert.' }
  })

  // The main session is the lead: busy while a turn runs.
  on('turn.start', async ($, e, next) => {
    await update($, board, b => ({ ...b, leadBusy: true }))
    ensureTicker($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await update($, board, b => ({ ...b, leadBusy: false }))
    ensureTicker($)
    return done
  })

  // Subagents (Agent tool, workflows): one bar each, model as resolved.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r && !('deny' in r && r.deny) && r.agentId) {
      await addRun($, {
        id: r.agentId,
        kind: 'claude',
        model: r.model,
        label: e.description || e.subagentType,
        role: (() => {
          const r1 = roleOf(e.description ?? '', e.subagentType)
          return r1 === 'generaliste' ? roleOf(String(e.prompt ?? '').slice(0, 300)) : r1
        })(),
        status: 'running',
        steps: 0,
        startedAt: await $.clock.now(),
      })
    }
    return r
  })

  on('classic.SubagentStop', async ($, e, next) => {
    await finishRun($, e.agent_id, 'done')
    await settleBackground($, e.background_tasks)
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    await settleBackground($, e.background_tasks)
    return next(e)
  })

  // A background command's completion notice names its tool_use_id: the Gemini bar ends right then.
  on('session.append', async ($, e, next) => {
    const text = JSON.stringify((e as { message?: { content?: unknown } }).message?.content ?? '')
    if (text.includes('task-notification')) {
      const id = /<tool-use-id>([\w-]+)<\/tool-use-id>/.exec(text)?.[1]
      const status = /<status>(\w+)<\/status>/.exec(text)?.[1]
      if (id) {
        const b = await read($, board)
        if (b.runs.some(r => r.id === id && r.status === 'background')) {
          await finishRun($, id, status === 'failed' || status === 'error' ? 'error' : 'done')
        }
      }
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, any>

    // A subagent's own tool call: one more step on its bar.
    if (e.agentId) {
      const id = e.agentId
      void update($, board, b => ({ ...b, runs: b.runs.map(r => (r.id === id ? { ...r, steps: r.steps + 1 } : r)) }))
    }

    // The app's task list.
    if (tool === PLAN_TOOL) {
      const ran = await next(e)
      await update($, board, b => {
        let tasks = b.tasks
        if (Array.isArray(input.items)) {
          const plan: Task[] = input.items.map((it: { content: string; status: TaskStatus }, i: number) => ({
            id: `plan-${i + 1}`,
            label: String(it.content),
            status: it.status,
          }))
          tasks = [...tasks.filter(t => !t.id.startsWith('plan-')), ...plan]
          const fresh = input.scope && input.scope !== 'continuation'
          return { ...b, tasks, runs: fresh ? b.runs.filter(r => r.status === 'running' || r.status === 'background') : b.runs }
        }
        if (input.advance) {
          const cur = tasks.findIndex(t => t.id.startsWith('plan-') && t.status === 'in_progress')
          if (cur >= 0) tasks = tasks.map((t, i) => (i === cur ? { ...t, status: 'completed' as const } : t))
          const nxt = tasks.findIndex(t => t.id.startsWith('plan-') && t.status === 'pending')
          if (nxt >= 0) tasks = tasks.map((t, i) => (i === nxt ? { ...t, status: 'in_progress' as const } : t))
        }
        for (const n of Array.isArray(input.done) ? input.done : []) tasks = setPlanStatus(tasks, Number(n), 'completed')
        if (input.start != null) tasks = setPlanStatus(tasks, Number(input.start), 'in_progress')
        return { ...b, tasks }
      })
      ensureTicker($)
      return ran
    }

    if (tool === WRAP_TOOL) {
      const ran = await next(e)
      await update($, board, b => ({
        ...b,
        tasks: b.tasks.map(t => (t.id.startsWith('plan-') ? { ...t, status: 'completed' as const } : t)),
      }))
      return ran
    }

    // Claude Code's own task tools (CLI).
    if (tool === 'TaskCreate') {
      const ran = await next(e)
      const text = String((ran as { text?: string }).text ?? '')
      const id = /#?(\d+)/.exec(text)?.[1]
      if (id) {
        await update($, board, b => ({
          ...b,
          tasks: [...b.tasks, { id: `task-${id}`, label: String(input.subject), status: 'pending' as const }],
        }))
      }
      return ran
    }
    if (tool === 'TaskUpdate') {
      const ran = await next(e)
      const id = `task-${input.taskId}`
      await update($, board, b => ({
        ...b,
        tasks:
          input.status === 'deleted'
            ? b.tasks.filter(t => t.id !== id)
            : b.tasks.map(t =>
                t.id === id ? { ...t, label: input.subject ?? t.label, status: input.status ?? t.status } : t,
              ),
      }))
      return ran
    }

    // Gemini through the ask-gemini wrapper or agy.
    if (tool === 'Bash' && typeof input.command === 'string' && isGeminiRun(input.command)) {
      const command: string = input.command
      const task = /--task[= ](\w+)/.exec(command)?.[1]
      const background = input.run_in_background === true
      await addRun($, {
        id: String(e.tool_use_id),
        kind: 'gemini',
        model: geminiModel(command),
        label: String(input.description || (task ? `ask-gemini ${task}` : 'Gemini')),
        role: roleOf(String(input.description ?? ''), task),
        status: background ? 'background' : 'running',
        steps: 0,
        startedAt: await $.clock.now(),
        command: background ? command.slice(0, 200) : undefined,
      })
      const ran = await next(e)
      if (!background) {
        const failed = 'deny' in ran ? Boolean(ran.deny) : Boolean((ran as { isError?: boolean }).isError)
        const out = 'deny' in ran ? '' : String((ran as { text?: string }).text ?? '')
        await finishRun($, String(e.tool_use_id), failed ? 'error' : 'done', modelFromOutput(out))
      }
      return ran
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    // Desktop-like surfaces space text lines apart, which breaks the pixel bodies: draw them as SVG.
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    const b = await read($, board)
    const a = await read($, anim)
    const all = overall(b)
    const cols = (e.props as { bodyColumns?: number }).bodyColumns ?? 60
    const width = Math.max(10, Math.min(28, Math.floor(cols / 3)))
    const spin = SPINNER[a.frame % SPINNER.length] ?? '•'

    /** A bar filled to `fraction`, with eighth-cell precision. */
    const filled = (fraction: number) => {
      const exact = Math.max(0, Math.min(1, fraction)) * width
      const full = Math.floor(exact)
      const part = ' ▏▎▍▌▋▊▉'[Math.round((exact - full) * 7)] ?? ''
      const head = full < width && part.trim() ? part : ''
      return { on: '█'.repeat(full) + head, off: '░'.repeat(width - full - (head ? 1 : 0)) }
    }

    /** A bar with no known end: a lit segment that sweeps back and forth. */
    const sweep = (offset: number) => {
      const seg = Math.max(3, Math.floor(width / 4))
      const span = width - seg
      const t = (a.frame + offset) % (2 * span || 1)
      const pos = t <= span ? t : 2 * span - t
      return { before: '░'.repeat(pos), lit: '█'.repeat(seg), after: '░'.repeat(width - pos - seg) }
    }

    type Row = {
      label: string
      state: 'pending' | 'live' | 'done' | 'error'
      detail: string
      color?: string
      /** When it ended, for the flash. */
      endedAt?: number
      offset: number
    }

    const row = (r: Row) => {
      const flash = r.endedAt != null && a.now - r.endedAt < FLASH_MS
      if (r.state === 'live') {
        const s = sweep(r.offset)
        return (
          <Text>
            <Text color={r.color}>{spin}</Text> <Text dimColor>{s.before}</Text>
            <Text color={r.color}>{s.lit}</Text>
            <Text dimColor>{s.after}</Text> {r.label} <Text dimColor>{r.detail}</Text>
          </Text>
        )
      }
      if (r.state === 'pending') {
        return (
          <Text dimColor>
            ○ {'░'.repeat(width)} {r.label} {r.detail}
          </Text>
        )
      }
      const ok = r.state === 'done'
      const color = ok ? (flash ? r.color : 'success') : 'error'
      return (
        <Text>
          <Text color={color} bold={flash}>
            {ok ? '✓' : '✗'}
          </Text>{' '}
          <Text color={ok ? r.color : 'error'} dimColor={!flash && ok}>
            {'█'.repeat(width)}
          </Text>{' '}
          <Text bold={flash}>{r.label}</Text> <Text dimColor>{r.detail}</Text>
        </Text>
      )
    }

    /** A character beside its name, role, state and bar. */
    const card = (c: {
      kind: 'claude' | 'gemini'
      name: string
      role: Parameters<typeof sprite>[1]
      mood: Mood
      color: string
      bar: Row['state']
      detail: string
      endedAt?: number
      offset: number
    }) => {
      // Theme keys don't paint a background reliably everywhere: give the body a raw color.
      const bodyColor = c.color.startsWith('#') ? c.color : '#d97757'
      const lines = sprite(c.kind, c.role, c.mood, a.frame + c.offset, bodyColor)
      const busy = c.mood === 'busy'
      const state = busy ? 'occupé' : c.mood === 'error' ? 'en échec' : 'libre'
      return (
        <Box flexDirection="row" gap={1}>
          {Svg ? (
            <Svg
              source={svgOf(c.kind, c.role, c.mood, bodyColor)}
              alt={`${c.name}, ${ROLE_LABEL[c.role]}, ${c.mood === 'busy' ? 'occupé' : 'libre'}`}
              width={SPRITE_WIDTH * 8}
              height={SPRITE_LINES * 16}
              isInteractive
            />
          ) : (
          <Box flexDirection="column">
            {lines.map(line => (
              <Text mono dimColor={c.mood === 'rest'}>
                {line.map(span => (
                  <Text color={span.fg} backgroundColor={span.bg} bold={span.bold}>
                    {span.t}
                  </Text>
                ))}
              </Text>
            ))}
          </Box>
          )}
          <Box flexDirection="column">
            <Text>
              <Text bold color={c.color}>
                {c.name}
              </Text>{' '}
              <Text dimColor>· {ROLE_LABEL[c.role]} ·</Text>{' '}
              <Text color={busy ? 'warning' : c.mood === 'error' ? 'error' : 'success'}>{state}</Text>
            </Text>
            {row({ label: '', state: c.bar, detail: '', color: c.color, endedAt: c.endedAt, offset: c.offset })}
            <Text dimColor>{c.detail}</Text>
          </Box>
        </Box>
      )
    }

    const lead = card({
      kind: 'claude',
      name: 'Claude',
      role: 'orchestrateur',
      mood: b.leadBusy ? 'busy' : 'rest',
      color: '#d97757',
      bar: b.leadBusy ? 'live' : 'pending',
      detail: b.leadBusy ? 'chef de projet · dirige la session' : 'chef de projet · attend ton message',
      offset: 0,
    })

    if (all.max === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          {lead}
          <Text dimColor>Rien en cours. Les tâches et les sous-agents apparaîtront ici.</Text>
        </Box>
      )
    }

    const g = filled(a.shown)
    const pct = Math.round(a.shown * 100)
    const finished = all.value >= all.max && a.shown >= 0.999

    const { Button } = els
    return (
      <Box flexDirection="column" gap={1}>
        <Button key="open-office" label="Vue bureau" onPress={() => void $.ui.open({ id: OFFICE, title: OFFICE_TITLE })} />
        {lead}
        <Box flexDirection="column">
          <Text bold>
            {finished ? '✓' : spin} Avancement général <Text color="claude">{pct} %</Text>
            <Text dimColor>
              {'  '}
              {Number.isInteger(all.value) ? all.value : all.value.toFixed(1)}/{all.max}
            </Text>
          </Text>
          <Text>
            <Text color={finished ? 'success' : 'claude'}>{g.on}</Text>
            <Text dimColor>{g.off}</Text>
          </Text>
        </Box>

        {b.tasks.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Tâches</Text>
            {b.tasks.map((t, i) =>
              row({
                label: t.label,
                state: t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'live' : 'pending',
                detail: t.status === 'completed' ? 'fait' : t.status === 'in_progress' ? 'en cours' : 'à faire',
                color: 'claude',
                offset: i * 3,
              }),
            )}
          </Box>
        )}

        {b.runs.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Équipe</Text>
            {b.runs.map((r, i) => {
              const f = family(r.model)
              const live = isLive(r)
              const mood: Mood = live
                ? 'busy'
                : r.status === 'error'
                  ? 'error'
                  : r.endedAt != null && a.now - r.endedAt < FLASH_MS * 3
                    ? 'happy'
                    : 'rest'
              const detail = live
                ? r.kind === 'claude'
                  ? `${r.label} · ${r.steps} outil${r.steps > 1 ? 's' : ''} · ${seconds(r, a.now)}`
                  : `${r.label} · ${r.status === 'background' ? 'arrière-plan' : 'en cours'} · ${seconds(r, a.now)}`
                : `${r.label} · ${r.status === 'error' ? 'échec' : 'fini'} en ${seconds(r)}`
              return card({
                kind: r.kind,
                name: f.name,
                role: r.role ?? 'generaliste',
                mood,
                color: f.color,
                bar: live ? 'live' : r.status === 'error' ? 'error' : 'done',
                detail,
                endedAt: r.endedAt,
                offset: (i + 1) * 5,
              })
            })}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: OFFICE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    if (!Svg) {
      return (
        <Box flexDirection="column">
          <Text dimColor>La vue bureau est dessinée en image : ouvre-la dans l’app de bureau ou VS Code.</Text>
        </Box>
      )
    }
    const b = await read($, board)
    // Read so the pane redraws on every tick (that is what lets a departure start and finish)...
    await read($, anim)
    // ...but time comes from the clock itself, not the ticker's last value: right even if nothing
    // ticked since.
    const now = await $.clock.now()
    const desks: Desk[] = b.runs.map(r => {
      const f = family(r.model)
      const live = isLive(r)
      return {
        id: r.id,
        kind: r.kind,
        role: r.role ?? 'generaliste',
        mood: live ? 'busy' : r.status === 'error' ? 'error' : r.endedAt != null && now - r.endedAt < FLASH_MS * 3 ? 'happy' : 'rest',
        color: f.color.startsWith('#') ? f.color : '#d97757',
        name: f.name,
        label: r.label,
        arrivedAt: r.startedAt,
        seat: r.seat,
        // Only a finished run has an end: a live one never leaves.
        endedAt: live ? undefined : r.endedAt,
      }
    })
    const lead = { mood: (b.leadBusy ? 'busy' : 'rest') as Mood, color: '#d97757' }
    // The key leaves time out: the scene is rebuilt when a desk, a mood that matters or a seat
    // changes. Arrivals, the lead's round and departures are planned in the scene and play alone.
    const key = officeKey(desks, lead.mood, now, FRESH_MS)
    // It is also rebuilt once when everything planned in it is over: a scene reloaded later (the
    // pane reopened) would otherwise replay arrivals and departures that already happened.
    if (!officeCache || officeCache.key !== key || (now >= officeCache.settleAt && officeCache.builtAt < officeCache.settleAt)) {
      const built = officeWithin({ desks, lead, now, epoch: OFFICE_EPOCH, freshMs: FRESH_MS, maxSeat: b.maxSeat, seats: b.seats })
      officeCache = { key, builtAt: now, ...built }
    }
    const busy = b.runs.filter(isLive).length
    // Whoever has already walked out is neither at work nor free.
    const left = b.runs.filter(r => !isLive(r) && r.endedAt != null && now - r.endedAt >= LEAVE_AFTER_MS + LEAVE_ANIM_MS).length
    const free = b.runs.length - busy - left
    // Fill the pane's width (a column is about 7.5 CSS px on desktop), keeping the scene's shape;
    // without a size, the frame an interactive SVG is drawn in stays at its small default.
    const cols = (e.props as { bodyColumns?: number }).bodyColumns ?? 120
    const scene = sceneSize(officeCache.shown)
    const width = Math.round(Math.min(1800, Math.max(420, cols * 7.5)))
    const height = Math.round((width * scene.h) / scene.w)
    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>
          {busy} agent{busy > 1 ? 's' : ''} au travail · {free} libre{free > 1 ? 's' : ''}
          {officeCache.hidden ? ` · ${officeCache.hidden} plus ancien${officeCache.hidden > 1 ? 's' : ''} masqué${officeCache.hidden > 1 ? 's' : ''}` : ''}
        </Text>
        <Svg
          source={officeCache.svg}
          alt={`Bureau : ${busy + free} agents, ${busy} au travail`}
          width={width}
          height={height}
          isInteractive
        />
      </Box>
    )
  })
}
