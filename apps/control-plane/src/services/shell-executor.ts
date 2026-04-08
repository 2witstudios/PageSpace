import { exec as cpExec, execFile as cpExecFile } from 'child_process'

export type ExecResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type ExecOptions = {
  cwd?: string
  timeout?: number
  env?: Record<string, string>
}

export type HistoryEntry = {
  command: string
  args?: string[]
  exitCode: number
  options?: ExecOptions
}

export interface ShellExecutor {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>
  execFile(program: string, args: string[], options?: ExecOptions): Promise<ExecResult>
  history: HistoryEntry[]
}

export function createShellExecutor(): ShellExecutor {
  const history: HistoryEntry[] = []

  return {
    history,
    async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
      return new Promise((resolve) => {
        cpExec(command, {
          cwd: options.cwd,
          timeout: options.timeout,
          env: options.env ? { ...process.env, ...options.env } : undefined,
        }, (error, stdout, stderr) => {
          const exitCode = error ? (error.code ?? 1) : 0
          const entry: HistoryEntry = { command, exitCode }
          if (Object.keys(options).length > 0) entry.options = options
          history.push(entry)
          resolve({ stdout, stderr, exitCode })
        })
      })
    },
    async execFile(program: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
      return new Promise((resolve) => {
        cpExecFile(program, args, {
          cwd: options.cwd,
          timeout: options.timeout,
          env: options.env ? { ...process.env, ...options.env } : undefined,
        }, (error, stdout, stderr) => {
          const exitCode = error ? (error.code as number ?? 1) : 0
          const entry: HistoryEntry = { command: program, args, exitCode }
          if (Object.keys(options).length > 0) entry.options = options
          history.push(entry)
          resolve({ stdout, stderr, exitCode })
        })
      })
    },
  }
}

type MockResponse = ExecResult & { delay?: number }

export function createMockExecutor(responses: MockResponse[]): ShellExecutor {
  const history: HistoryEntry[] = []
  let callIndex = 0

  return {
    history,
    async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
      const response = responses[callIndex] ?? { stdout: '', stderr: '', exitCode: -1 }
      callIndex++

      if (response.delay && options.timeout && response.delay > options.timeout) {
        const result = { stdout: '', stderr: 'command timed out', exitCode: -1 }
        const entry: HistoryEntry = { command, exitCode: result.exitCode }
        if (Object.keys(options).length > 0) entry.options = options
        history.push(entry)
        return result
      }

      if (response.delay) {
        await new Promise((resolve) => setTimeout(resolve, response.delay))
      }

      const entry: HistoryEntry = { command, exitCode: response.exitCode }
      if (Object.keys(options).length > 0) entry.options = options
      history.push(entry)
      return { stdout: response.stdout, stderr: response.stderr, exitCode: response.exitCode }
    },
    async execFile(program: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
      const response = responses[callIndex] ?? { stdout: '', stderr: '', exitCode: -1 }
      callIndex++

      if (response.delay && options.timeout && response.delay > options.timeout) {
        const result = { stdout: '', stderr: 'command timed out', exitCode: -1 }
        const entry: HistoryEntry = { command: program, args, exitCode: result.exitCode }
        if (Object.keys(options).length > 0) entry.options = options
        history.push(entry)
        return result
      }

      if (response.delay) {
        await new Promise((resolve) => setTimeout(resolve, response.delay))
      }

      const entry: HistoryEntry = { command: program, args, exitCode: response.exitCode }
      if (Object.keys(options).length > 0) entry.options = options
      history.push(entry)
      return { stdout: response.stdout, stderr: response.stderr, exitCode: response.exitCode }
    },
  }
}
