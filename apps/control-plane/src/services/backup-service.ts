import type { ShellExecutor } from './shell-executor'
import { validateSlug } from '../validation/tenant-validation'

export type BackupServiceRepo = {
  createBackupRecord(input: { tenantId: string; backupPath: string; status: 'running' }): Promise<{ id: string }>
  updateBackupRecord(id: string, updates: { status: 'completed' | 'failed'; sizeBytes?: number; completedAt?: Date }): Promise<void>
  listBackupRecords(tenantId: string): Promise<Array<{ id: string; backupPath: string; startedAt: Date; status: string }>>
  deleteBackupRecord(id: string): Promise<void>
  recordEvent(tenantId: string, eventType: string, metadata?: unknown): Promise<void>
}

export type BackupFs = {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  stat(path: string): Promise<{ size: number }>
  unlink(path: string): Promise<void>
}

export type BackupDeps = {
  executor: ShellExecutor
  repo: BackupServiceRepo
  fs: BackupFs
  backupsPath: string
  composePath: string
  basePath: string
  now?: () => Date
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

function getWeekKey(date: Date): string {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7))
  const week1 = new Date(d.getFullYear(), 0, 4)
  const weekNum = 1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7)
  return `${d.getFullYear()}-W${weekNum}`
}

export function createBackupService(deps: BackupDeps) {
  const { executor, repo, fs, backupsPath, composePath, basePath, now = () => new Date() } = deps

  function composeCmd(slug: string, action: string): string {
    return `docker compose -p ps-${slug} -f ${composePath} --env-file ${basePath}/${slug}/.env ${action}`
  }

  return {
    async backupTenant(tenantId: string, slug: string): Promise<{ id: string; dbPath: string; filesPath: string }> {
      const slugResult = validateSlug(slug)
      if (!slugResult.valid) throw new Error(`Invalid slug: ${slugResult.error}`)

      const timestamp = formatTimestamp(now())
      const backupDir = `${backupsPath}/${slug}`
      const dbPath = `${backupDir}/${timestamp}.sql.gz`
      const filesPath = `${backupDir}/${timestamp}-files.tar.gz`

      await fs.mkdir(backupDir, { recursive: true })

      const record = await repo.createBackupRecord({
        tenantId,
        backupPath: dbPath,
        status: 'running',
      })

      try {
        const dumpResult = await executor.exec(
          `${composeCmd(slug, 'exec -T postgres pg_dump -U pagespace -d pagespace')} | gzip > ${dbPath}`,
          { cwd: basePath }
        )
        if (dumpResult.exitCode !== 0) {
          throw new Error(`pg_dump failed: ${dumpResult.stderr}`)
        }

        // tar file storage (non-fatal — db dump is the primary backup)
        await executor.exec(
          `${composeCmd(slug, 'exec -T web tar czf - /app/file_storage')} > ${filesPath}`,
          { cwd: basePath }
        )

        const stats = await fs.stat(dbPath)
        await repo.updateBackupRecord(record.id, {
          status: 'completed',
          sizeBytes: stats.size,
          completedAt: now(),
        })
        await repo.recordEvent(tenantId, 'backup_completed', {
          backupPath: dbPath,
          sizeBytes: stats.size,
        })

        return { id: record.id, dbPath, filesPath }
      } catch (error) {
        try {
          await repo.updateBackupRecord(record.id, {
            status: 'failed',
            completedAt: now(),
          })
          await repo.recordEvent(tenantId, 'backup_failed', {
            error: (error as Error).message,
          })
        } catch {
          // Best-effort status update
        }
        throw error
      }
    },

    async pruneBackups(tenantId: string, retention: { daily: number; weekly: number }): Promise<{ deleted: number }> {
      const backups = await repo.listBackupRecords(tenantId)
      const completed = backups.filter(b => b.status === 'completed')
      const sorted = [...completed].sort(
        (a, b) => b.startedAt.getTime() - a.startedAt.getTime()
      )

      const toKeep = new Set<string>()

      // Keep the N most recent as daily backups
      sorted.slice(0, retention.daily).forEach(b => toKeep.add(b.id))

      // Keep 1 per ISO week for M weeks beyond the daily window
      if (retention.weekly > 0) {
        const remaining = sorted.filter(b => !toKeep.has(b.id))
        const weeksKept = new Set<string>()
        for (const backup of remaining) {
          const weekKey = getWeekKey(backup.startedAt)
          if (!weeksKept.has(weekKey) && weeksKept.size < retention.weekly) {
            toKeep.add(backup.id)
            weeksKept.add(weekKey)
          }
        }
      }

      const toDelete = sorted.filter(b => !toKeep.has(b.id))
      for (const backup of toDelete) {
        try { await fs.unlink(backup.backupPath) } catch { /* file may not exist */ }
        try { await fs.unlink(backup.backupPath.replace('.sql.gz', '-files.tar.gz')) } catch { /* companion archive may not exist */ }
        await repo.deleteBackupRecord(backup.id)
      }

      return { deleted: toDelete.length }
    },

    async restoreTenant(slug: string, backupPath: string): Promise<{ success: boolean }> {
      const slugResult = validateSlug(slug)
      if (!slugResult.valid) throw new Error(`Invalid slug: ${slugResult.error}`)

      if (!backupPath.startsWith(backupsPath + '/')) {
        throw new Error('Backup path must be within the backups directory')
      }

      // Restore database
      const result = await executor.exec(
        `gunzip -c ${backupPath} | ${composeCmd(slug, 'exec -T postgres psql -U pagespace -d pagespace')}`,
        { cwd: basePath }
      )
      if (result.exitCode !== 0) {
        throw new Error(`Restore failed: ${result.stderr}`)
      }

      // Restore files (non-fatal — archive may not exist)
      const filesBackupPath = backupPath.replace('.sql.gz', '-files.tar.gz')
      try {
        await executor.exec(
          `${composeCmd(slug, 'exec -T web tar xzf - -C /')} < ${filesBackupPath}`,
          { cwd: basePath }
        )
      } catch {
        // Best-effort file restoration
      }

      return { success: true }
    },
  }
}
