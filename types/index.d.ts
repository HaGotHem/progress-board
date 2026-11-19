export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type Task = { id: string; label: string; status: TaskStatus }

/** What kind of work an agent does; picks its character's hat and tool. */
export type Role = 'verification' | 'recherche' | 'creation' | 'architecte' | 'orchestrateur' | 'generaliste'

/** busy: working; happy: just finished; rest: finished a while ago or waiting; error: failed. */
export type Mood = 'busy' | 'happy' | 'rest' | 'error'

export type RunStatus = 'running' | 'background' | 'done' | 'error'

export type Run = {
  /** agentId for a subagent, tool_use_id for a Gemini call */
  id: string
  kind: 'claude' | 'gemini'
  /** model id as resolved, e.g. claude-sonnet-5-5 or gemini-4-argon-high */
  model: string
  label: string
  status: RunStatus
  /** tool calls the subagent made so far */
  steps: number
  startedAt: number
  endedAt?: number
  /** Guessed from the task; absent on runs an earlier version stored. */
  role?: Role
  /** Bash command of a background Gemini call, to find it in background_tasks */
  command?: string
  /** Its desk in the office, given once at arrival and kept. */
  seat?: number
}

export type Board = {
  tasks: Task[]
  runs: Run[]
  /** Whether the main session (the lead) is in a turn right now. */
  leadBusy?: boolean
  /** The main session's model id, read at each turn start; absent until the first turn. */
  leadModel?: string
  /** The highest seat (desk) ever handed out in the office. Absent on a board an earlier version stored. */
  maxSeat?: number
  /** What each seat last held, so its desk is still drawn when its run left the history. Same absence. */
  seats?: ({ role: Role; itemKey: string } | null)[]
}

/** What the animation loop advances: a frame counter, the clock, and the eased fill of the overall bar. */
export type Anim = { frame: number; now: number; shown: number }

declare module 'claude-code' {
  interface PluginState {
    'progress-board': { board: Shaped<Board>; anim: Shaped<Anim> }
  }
}
