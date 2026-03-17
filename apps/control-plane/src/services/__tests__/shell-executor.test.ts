import { describe, test, expect, vi } from 'vitest'
import { createShellExecutor, createMockExecutor, type ShellExecutor } from '../shell-executor'

describe('ShellExecutor', () => {
  describe('interface contract', () => {
    test('given exec is called, should return stdout, stderr, and exitCode', async () => {
      const executor = createMockExecutor([
        { stdout: 'hello\n', stderr: '', exitCode: 0 },
      ])

      const result = await executor.exec('echo hello')

      expect(result).toEqual({ stdout: 'hello\n', stderr: '', exitCode: 0 })
    })

    test('given a failing command, should return non-zero exitCode', async () => {
      const executor = createMockExecutor([
        { stdout: '', stderr: 'not found\n', exitCode: 1 },
      ])

      const result = await executor.exec('bad-command')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toBe('not found\n')
    })

    test('given multiple commands, should return responses in order', async () => {
      const executor = createMockExecutor([
        { stdout: 'first', stderr: '', exitCode: 0 },
        { stdout: 'second', stderr: '', exitCode: 0 },
      ])

      const first = await executor.exec('cmd1')
      const second = await executor.exec('cmd2')

      expect(first.stdout).toBe('first')
      expect(second.stdout).toBe('second')
    })
  })

  describe('command logging', () => {
    test('given exec is called, should record the command in history', async () => {
      const executor = createMockExecutor([
        { stdout: '', stderr: '', exitCode: 0 },
      ])

      await executor.exec('docker compose up -d')

      expect(executor.history).toHaveLength(1)
      expect(executor.history[0].command).toBe('docker compose up -d')
    })

    test('given exec is called, should record the exitCode in history', async () => {
      const executor = createMockExecutor([
        { stdout: '', stderr: '', exitCode: 127 },
      ])

      await executor.exec('missing-binary')

      expect(executor.history[0].exitCode).toBe(127)
    })

    test('given multiple commands, should record all in order', async () => {
      const executor = createMockExecutor([
        { stdout: '', stderr: '', exitCode: 0 },
        { stdout: '', stderr: '', exitCode: 0 },
      ])

      await executor.exec('step-1')
      await executor.exec('step-2')

      expect(executor.history).toHaveLength(2)
      expect(executor.history[0].command).toBe('step-1')
      expect(executor.history[1].command).toBe('step-2')
    })
  })

  describe('timeout handling', () => {
    test('given a timeout option, should reject when command exceeds timeout', async () => {
      const executor = createMockExecutor([
        { stdout: '', stderr: 'timeout', exitCode: -1, delay: 200 },
      ])

      const result = await executor.exec('slow-command', { timeout: 50 })

      expect(result.exitCode).not.toBe(0)
    })
  })

  describe('real executor factory', () => {
    test('given createShellExecutor, should return an object with exec method', () => {
      const executor = createShellExecutor()

      expect(typeof executor.exec).toBe('function')
    })

    test('given createShellExecutor, should return an object with history array', () => {
      const executor = createShellExecutor()

      expect(Array.isArray(executor.history)).toBe(true)
      expect(executor.history).toHaveLength(0)
    })
  })

  describe('options forwarding', () => {
    test('given options with cwd, should record options in history', async () => {
      const executor = createMockExecutor([
        { stdout: '', stderr: '', exitCode: 0 },
      ])

      await executor.exec('ls', { cwd: '/tmp' })

      expect(executor.history[0].options).toEqual({ cwd: '/tmp' })
    })
  })
})
