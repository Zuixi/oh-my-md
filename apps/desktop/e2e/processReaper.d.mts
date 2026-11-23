// Type surface for `processReaper.mjs` so the supervisor regression suite can import the
// runtime module from TypeScript without `allowJs`.
export interface RunSandbox {
  runId: string
  runTag: string
  runTmpDir: string
  childEnv(baseEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
  cleanupTmpDir(): void
}

export interface PsRow {
  pid: number
  ppid: number
  pgid: number
  command: string
}

export interface ReapTargets {
  targetPids: number[]
  targetPgids: number[]
}

export interface SelectReapTargetsInput {
  rootPid: number | null
  runTag: string
  runTmpDir: string
  selfPid: number
  parentPid: number
}

export interface ReapRunProcessesOptions {
  rootPid?: number | null
  runTag?: string
  runTmpDir?: string
  graceMs?: number
}

export function createRunSandbox(prefix?: string): RunSandbox
export function parsePosixPs(stdout: string): PsRow[]
export function selectReapTargets(rows: PsRow[], input: SelectReapTargetsInput): ReapTargets
export function reapRunProcessesSync(options?: ReapRunProcessesOptions): void
export function installBrokenPipeGuard(onBrokenPipe: () => void): () => void
