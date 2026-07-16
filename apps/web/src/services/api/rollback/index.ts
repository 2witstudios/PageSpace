/**
 * Rollback service — public barrel + composition root.
 *
 * Binds the imperative shell to the production dependencies and re-exports the
 * frozen public API: 6 functions + 5 types. The functional core (pure decision
 * modules) and the shell (effectful modules taking RollbackDeps) live alongside
 * this file; nothing outside rollback/ imports them directly.
 */
import type { db } from '@pagespace/db/db'
import type { RollbackContext } from '@pagespace/lib/permissions/rollback-permissions'
import type { ActivityActionPreview } from '@/types/activity-actions'
import { defaultRollbackDeps } from './deps'
import type { ActivityLogForRollback } from './types'
import {
  getActivityById as repoGetActivityById,
  getPageVersionHistory as repoGetPageVersionHistory,
  getDriveVersionHistory as repoGetDriveVersionHistory,
  getUserRetentionDays as repoGetUserRetentionDays,
  type VersionHistoryOptions,
  type VersionHistoryPage,
} from './activity-repo'
import {
  executeRollback as shellExecuteRollback,
  previewRollback as shellPreviewRollback,
  type RollbackResult,
} from './execute'

// Re-export the frozen public types (5).
export type { RollbackContext }
export type { ActivityLogForRollback }
export type { VersionHistoryOptions }
export type { RollbackResult }
/** Result of a rollback preview */
export type RollbackPreview = ActivityActionPreview

// Production dependency bag (real db, clock, and effect functions).
const deps = defaultRollbackDeps()

/** Fetch a single activity log by ID */
export async function getActivityById(activityId: string): Promise<ActivityLogForRollback | null> {
  return repoGetActivityById(deps, activityId)
}

/** Preview what a rollback would do */
export async function previewRollback(
  activityId: string,
  userId: string,
  context: RollbackContext,
  options?: { force?: boolean; undoGroupActivityIds?: string[] }
): Promise<RollbackPreview> {
  return shellPreviewRollback(deps, activityId, userId, context, options)
}

/**
 * Execute a rollback operation
 * @param options.tx - Optional transaction to use for all database operations (for atomicity)
 * @param options.force - Skip conflict check if resource was modified since activity
 */
export async function executeRollback(
  activityId: string,
  userId: string,
  context: RollbackContext,
  options?: { tx?: typeof db; force?: boolean; undoGroupActivityIds?: string[] }
): Promise<RollbackResult> {
  return shellExecuteRollback(deps, activityId, userId, context, options)
}

/** Get version history for a page */
export async function getPageVersionHistory(
  pageId: string,
  userId: string,
  options: VersionHistoryOptions = {}
): Promise<VersionHistoryPage> {
  return repoGetPageVersionHistory(deps, pageId, userId, options)
}

/** Get version history for a drive (admin view) */
export async function getDriveVersionHistory(
  driveId: string,
  userId: string,
  options: VersionHistoryOptions = {}
): Promise<VersionHistoryPage> {
  return repoGetDriveVersionHistory(deps, driveId, userId, options)
}

/** Get user's retention limit based on subscription tier */
export async function getUserRetentionDays(userId: string): Promise<number> {
  return repoGetUserRetentionDays(deps, userId)
}
