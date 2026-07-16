/**
 * Rollback Service — composition root.
 *
 * Handles version history rollback operations for PageSpace. The functional
 * core (pure decision modules) and the imperative shell (effectful modules that
 * take a RollbackDeps) live under services/api/rollback/. This file binds the
 * shell to the production deps and re-exports the frozen public API so existing
 * consumers (ai-undo-service, rollback-to-point-service) compile untouched.
 */
import type { db } from '@pagespace/db/db'
import type { RollbackContext } from '@pagespace/lib/permissions/rollback-permissions'
import type { ActivityActionPreview } from '@/types/activity-actions'
import { defaultRollbackDeps } from './rollback/deps'
import type { ActivityLogForRollback } from './rollback/types'
import {
  getActivityById as repoGetActivityById,
  getPageVersionHistory as repoGetPageVersionHistory,
  getDriveVersionHistory as repoGetDriveVersionHistory,
  getUserRetentionDays as repoGetUserRetentionDays,
  type VersionHistoryOptions,
} from './rollback/activity-repo'
import {
  executeRollback as shellExecuteRollback,
  previewRollback as shellPreviewRollback,
  type RollbackResult,
} from './rollback/execute'

// Re-export the frozen public types.
export type { RollbackContext }
export type { ActivityLogForRollback }
export type { VersionHistoryOptions }
export type { RollbackResult }
/** Result of a rollback preview */
export type RollbackPreview = ActivityActionPreview

// Production dependency bag (real db, clock, and effect functions).
const deps = defaultRollbackDeps()

/**
 * Fetch a single activity log by ID
 */
export async function getActivityById(activityId: string): Promise<ActivityLogForRollback | null> {
  return repoGetActivityById(deps, activityId)
}

/**
 * Preview what a rollback would do
 */
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

/**
 * Get version history for a page
 */
export async function getPageVersionHistory(
  pageId: string,
  userId: string,
  options: VersionHistoryOptions = {}
): Promise<{ activities: ActivityLogForRollback[]; total: number }> {
  return repoGetPageVersionHistory(deps, pageId, userId, options)
}

/**
 * Get version history for a drive (admin view)
 */
export async function getDriveVersionHistory(
  driveId: string,
  userId: string,
  options: VersionHistoryOptions = {}
): Promise<{ activities: ActivityLogForRollback[]; total: number }> {
  return repoGetDriveVersionHistory(deps, driveId, userId, options)
}

/**
 * Get user's retention limit based on subscription tier
 */
export async function getUserRetentionDays(userId: string): Promise<number> {
  return repoGetUserRetentionDays(deps, userId)
}
