import { describe, test, expect, vi } from 'vitest'
import { createBackupService, type BackupDeps } from '../backup-service'

function makeMockRepo() {
  return {
    createBackupRecord: vi.fn().mockResolvedValue({ id: 'backup-1' }),
    updateBackupRecord: vi.fn().mockResolvedValue(undefined),
    listBackupRecords: vi.fn().mockResolvedValue([]),
    deleteBackupRecord: vi.fn().mockResolvedValue(undefined),
    recordEvent: vi.fn().mockResolvedValue(undefined),
  }
}

function makeMockExecutor() {
  return {
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    history: [] as Array<{ command: string; exitCode: number }>,
  }
}

function makeMockFs() {
  return {
    mkdir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 4096 }),
    unlink: vi.fn().mockResolvedValue(undefined),
  }
}

const FIXED_DATE = new Date('2025-06-15T10:30:00.000Z')

function makeDeps(overrides: Partial<BackupDeps> = {}): BackupDeps {
  return {
    executor: makeMockExecutor(),
    repo: makeMockRepo(),
    fs: makeMockFs(),
    backupsPath: '/data/backups',
    now: () => FIXED_DATE,
    ...overrides,
  }
}

describe('BackupService', () => {
  describe('backupTenant', () => {
    test('given a tenant slug, should create backup directory at backups/{slug}/', async () => {
      const deps = makeDeps()
      const service = createBackupService(deps)

      await service.backupTenant('tenant-1', 'acme')

      expect(deps.fs.mkdir).toHaveBeenCalledWith('/data/backups/acme', { recursive: true })
    })

    test('given a tenant slug, should run pg_dump via docker compose exec', async () => {
      const deps = makeDeps()
      const service = createBackupService(deps)

      await service.backupTenant('tenant-1', 'acme')

      const dumpCall = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes('pg_dump')
      )
      expect(dumpCall).toBeDefined()
      expect(dumpCall![0]).toContain('docker compose -p ps-acme')
      expect(dumpCall![0]).toContain('exec -T postgres pg_dump')
      expect(dumpCall![0]).toContain('gzip')
    })

    test('given a tenant slug, should tar the file_storage volume', async () => {
      const deps = makeDeps()
      const service = createBackupService(deps)

      await service.backupTenant('tenant-1', 'acme')

      const tarCall = (deps.executor.exec as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes('tar')
      )
      expect(tarCall).toBeDefined()
      expect(tarCall![0]).toContain('docker compose -p ps-acme')
      expect(tarCall![0]).toContain('file_storage')
    })

    test('given a tenant slug, should save backups with timestamp in filename', async () => {
      const deps = makeDeps()
      const service = createBackupService(deps)

      await service.backupTenant('tenant-1', 'acme')

      expect(deps.repo.createBackupRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          backupPath: expect.stringContaining('2025-06-15'),
        })
      )
    })

    test('given successful pg_dump, should record backup with status=completed and file size', async () => {
      const deps = makeDeps()
      ;(deps.fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ size: 1048576 })
      const service = createBackupService(deps)

      await service.backupTenant('tenant-1', 'acme')

      expect(deps.repo.updateBackupRecord).toHaveBeenCalledWith('backup-1', expect.objectContaining({
        status: 'completed',
        sizeBytes: 1048576,
        completedAt: FIXED_DATE,
      }))
    })

    test('given successful backup, should record backup_completed event', async () => {
      const deps = makeDeps()
      const service = createBackupService(deps)

      await service.backupTenant('tenant-1', 'acme')

      expect(deps.repo.recordEvent).toHaveBeenCalledWith(
        'tenant-1',
        'backup_completed',
        expect.objectContaining({ sizeBytes: expect.any(Number) })
      )
    })

    test('given successful backup, should return backup id and paths', async () => {
      const deps = makeDeps()
      const service = createBackupService(deps)

      const result = await service.backupTenant('tenant-1', 'acme')

      expect(result.id).toBe('backup-1')
      expect(result.dbPath).toContain('/data/backups/acme/')
      expect(result.dbPath).toContain('.sql.gz')
      expect(result.filesPath).toContain('.tar.gz')
    })

    test('given pg_dump failure (exit code 1), should record status=failed', async () => {
      const deps = makeDeps()
      ;(deps.executor.exec as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        stdout: '', stderr: 'connection refused', exitCode: 1,
      })
      const service = createBackupService(deps)

      await expect(service.backupTenant('tenant-1', 'acme')).rejects.toThrow('pg_dump failed')

      expect(deps.repo.updateBackupRecord).toHaveBeenCalledWith('backup-1', expect.objectContaining({
        status: 'failed',
      }))
    })

    test('given pg_dump failure, should record backup_failed event with error message', async () => {
      const deps = makeDeps()
      ;(deps.executor.exec as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        stdout: '', stderr: 'connection refused', exitCode: 1,
      })
      const service = createBackupService(deps)

      await expect(service.backupTenant('tenant-1', 'acme')).rejects.toThrow()

      expect(deps.repo.recordEvent).toHaveBeenCalledWith(
        'tenant-1',
        'backup_failed',
        expect.objectContaining({ error: expect.stringContaining('connection refused') })
      )
    })

    test('given tar failure, should still complete backup (db dump is primary)', async () => {
      const deps = makeDeps()
      ;(deps.executor.exec as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // pg_dump succeeds
        .mockResolvedValueOnce({ stdout: '', stderr: 'tar error', exitCode: 1 }) // tar fails
      const service = createBackupService(deps)

      await service.backupTenant('tenant-1', 'acme')

      expect(deps.repo.updateBackupRecord).toHaveBeenCalledWith('backup-1', expect.objectContaining({
        status: 'completed',
      }))
    })

    test('given a backup request, should create record with status=running before executing', async () => {
      const deps = makeDeps()
      const service = createBackupService(deps)

      await service.backupTenant('tenant-1', 'acme')

      expect(deps.repo.createBackupRecord).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'running' })
      )
    })
  })

  describe('pruneBackups', () => {
    test('given 10 daily backups and 7-day retention, should prune the 3 oldest', async () => {
      const backups = Array.from({ length: 10 }, (_, i) => ({
        id: `backup-${i}`,
        backupPath: `/data/backups/acme/2025-01-${String(i + 1).padStart(2, '0')}.sql.gz`,
        startedAt: new Date(`2025-01-${String(i + 1).padStart(2, '0')}T10:00:00Z`),
        status: 'completed',
      }))
      const deps = makeDeps()
      ;(deps.repo.listBackupRecords as ReturnType<typeof vi.fn>).mockResolvedValue(backups)
      const service = createBackupService(deps)

      const result = await service.pruneBackups('tenant-1', { daily: 7, weekly: 0 })

      expect(result.deleted).toBe(3)
      expect(deps.repo.deleteBackupRecord).toHaveBeenCalledTimes(3)
    })

    test('given backups to prune, should delete backup files from filesystem', async () => {
      const backups = Array.from({ length: 10 }, (_, i) => ({
        id: `backup-${i}`,
        backupPath: `/data/backups/acme/2025-01-${String(i + 1).padStart(2, '0')}.sql.gz`,
        startedAt: new Date(`2025-01-${String(i + 1).padStart(2, '0')}T10:00:00Z`),
        status: 'completed',
      }))
      const deps = makeDeps()
      ;(deps.repo.listBackupRecords as ReturnType<typeof vi.fn>).mockResolvedValue(backups)
      const service = createBackupService(deps)

      await service.pruneBackups('tenant-1', { daily: 7, weekly: 0 })

      expect(deps.fs.unlink).toHaveBeenCalledTimes(3)
      // Should delete the 3 oldest
      expect(deps.fs.unlink).toHaveBeenCalledWith('/data/backups/acme/2025-01-01.sql.gz')
      expect(deps.fs.unlink).toHaveBeenCalledWith('/data/backups/acme/2025-01-02.sql.gz')
      expect(deps.fs.unlink).toHaveBeenCalledWith('/data/backups/acme/2025-01-03.sql.gz')
    })

    test('given fewer backups than retention limit, should prune none', async () => {
      const backups = Array.from({ length: 3 }, (_, i) => ({
        id: `backup-${i}`,
        backupPath: `/data/backups/acme/2025-01-${String(i + 1).padStart(2, '0')}.sql.gz`,
        startedAt: new Date(`2025-01-${String(i + 1).padStart(2, '0')}T10:00:00Z`),
        status: 'completed',
      }))
      const deps = makeDeps()
      ;(deps.repo.listBackupRecords as ReturnType<typeof vi.fn>).mockResolvedValue(backups)
      const service = createBackupService(deps)

      const result = await service.pruneBackups('tenant-1', { daily: 7, weekly: 0 })

      expect(result.deleted).toBe(0)
      expect(deps.repo.deleteBackupRecord).not.toHaveBeenCalled()
    })

    test('given weekly retention, should keep 1 per week beyond daily window', async () => {
      // 20 daily backups spanning 20 days across multiple weeks
      const backups = Array.from({ length: 20 }, (_, i) => ({
        id: `backup-${i}`,
        backupPath: `/data/backups/acme/2025-03-${String(i + 1).padStart(2, '0')}.sql.gz`,
        startedAt: new Date(`2025-03-${String(i + 1).padStart(2, '0')}T10:00:00Z`),
        status: 'completed',
      }))
      const deps = makeDeps()
      ;(deps.repo.listBackupRecords as ReturnType<typeof vi.fn>).mockResolvedValue(backups)
      const service = createBackupService(deps)

      const result = await service.pruneBackups('tenant-1', { daily: 7, weekly: 2 })

      // Keep 7 daily (most recent) + up to 2 weekly from the remaining 13
      // Total deleted = 20 - 7 - (up to 2 weekly) = at least 11
      expect(result.deleted).toBeGreaterThanOrEqual(11)
      expect(result.deleted).toBeLessThanOrEqual(13)
    })

    test('given only failed backups, should skip them in retention count', async () => {
      const backups = [
        { id: 'b-1', backupPath: '/p/1.sql.gz', startedAt: new Date('2025-01-01T10:00:00Z'), status: 'failed' },
        { id: 'b-2', backupPath: '/p/2.sql.gz', startedAt: new Date('2025-01-02T10:00:00Z'), status: 'completed' },
      ]
      const deps = makeDeps()
      ;(deps.repo.listBackupRecords as ReturnType<typeof vi.fn>).mockResolvedValue(backups)
      const service = createBackupService(deps)

      const result = await service.pruneBackups('tenant-1', { daily: 7, weekly: 0 })

      // 1 completed backup < 7 retention → keep all completed, skip failed
      expect(result.deleted).toBe(0)
    })

    test('given file unlink failure during pruning, should continue with remaining deletions', async () => {
      const backups = Array.from({ length: 10 }, (_, i) => ({
        id: `backup-${i}`,
        backupPath: `/data/backups/acme/2025-01-${String(i + 1).padStart(2, '0')}.sql.gz`,
        startedAt: new Date(`2025-01-${String(i + 1).padStart(2, '0')}T10:00:00Z`),
        status: 'completed',
      }))
      const deps = makeDeps()
      ;(deps.repo.listBackupRecords as ReturnType<typeof vi.fn>).mockResolvedValue(backups)
      ;(deps.fs.unlink as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ENOENT'))
      const service = createBackupService(deps)

      const result = await service.pruneBackups('tenant-1', { daily: 7, weekly: 0 })

      expect(result.deleted).toBe(3)
      expect(deps.repo.deleteBackupRecord).toHaveBeenCalledTimes(3)
    })
  })

  describe('restoreTenant', () => {
    test('given a valid backup path, should call pg restore with correct commands', async () => {
      const deps = makeDeps()
      const service = createBackupService(deps)

      await service.restoreTenant('acme', '/data/backups/acme/2025-01-15.sql.gz')

      expect(deps.executor.exec).toHaveBeenCalledWith(
        expect.stringContaining('gunzip'),
        expect.any(Object)
      )
      expect(deps.executor.exec).toHaveBeenCalledWith(
        expect.stringContaining('ps-acme'),
        expect.any(Object)
      )
    })

    test('given restore failure, should throw with error message', async () => {
      const deps = makeDeps()
      ;(deps.executor.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
        stdout: '', stderr: 'restore error', exitCode: 1,
      })
      const service = createBackupService(deps)

      await expect(
        service.restoreTenant('acme', '/data/backups/acme/2025-01-15.sql.gz')
      ).rejects.toThrow('Restore failed')
    })

    test('given successful restore, should return success result', async () => {
      const deps = makeDeps()
      const service = createBackupService(deps)

      const result = await service.restoreTenant('acme', '/data/backups/acme/2025-01-15.sql.gz')

      expect(result.success).toBe(true)
    })
  })
})
