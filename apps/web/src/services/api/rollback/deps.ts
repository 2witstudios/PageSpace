/**
 * Rollback dependency-injection seam.
 *
 * The imperative shell (page-mutation, activity-repo, preview, executors,
 * execute) takes its effects through a RollbackDeps bag instead of reaching for
 * modules directly. `db` doubles as the transaction handle: executeRollback
 * builds a deps whose `db` is `options.tx ?? realDb`, so one transaction threads
 * through every handler, createPageVersion, and logRollbackActivity. `clock` and
 * `genChangeGroupId` make time and id generation injectable for tests.
 */
import { db } from '@pagespace/db/db';
import {
  canUserRollback,
  isRollbackableOperation,
} from '@pagespace/lib/permissions/rollback-permissions';
import { logRollbackActivity, getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { createChangeGroupId, inferChangeGroupType } from '@pagespace/lib/monitoring/change-group';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { readPageContent } from '@pagespace/lib/services/page-content-store';
import { createPageVersion, type PageVersionSource } from '@pagespace/lib/services/page-version-service';
import type { ChangeGroupType } from '@pagespace/lib/monitoring/change-group';
import type { PageContentFormat } from '@pagespace/lib/content/page-content-format';
import type { SyncMentionsResult } from '@/services/api/page-mention-service';
import { syncMentions } from '@/services/api/page-mention-service';
import { createMentionNotification } from '@pagespace/lib/notifications/notifications';

export interface RollbackDeps {
  /** Database handle — the real db, or a transaction when one is threaded. */
  db: typeof db;
  /** Injected clock. */
  clock: () => Date;
  genChangeGroupId: typeof createChangeGroupId;
  inferChangeGroupType: typeof inferChangeGroupType;
  readContent: typeof readPageContent;
  syncMentions: typeof syncMentions;
  createPageVersion: typeof createPageVersion;
  getActorInfo: typeof getActorInfo;
  logRollbackActivity: typeof logRollbackActivity;
  canUserRollback: typeof canUserRollback;
  isRollbackableOperation: typeof isRollbackableOperation;
  createMentionNotification: typeof createMentionNotification;
  logger: typeof loggers.api;
}

/** Build the production deps from the real modules. */
export function defaultRollbackDeps(): RollbackDeps {
  return {
    db,
    clock: () => new Date(),
    genChangeGroupId: createChangeGroupId,
    inferChangeGroupType,
    readContent: readPageContent,
    syncMentions,
    createPageVersion,
    getActorInfo,
    logRollbackActivity,
    canUserRollback,
    isRollbackableOperation,
    createMentionNotification,
    logger: loggers.api,
  };
}

/** Return a deps bag whose db is the given transaction (or the base db). */
export function withTx(deps: RollbackDeps, tx?: typeof db): RollbackDeps {
  return tx ? { ...deps, db: tx } : deps;
}

// ─── Shared shell types ──────────────────────────────────────────────────────

export interface PageUpdateContext {
  userId: string;
  changeGroupId: string;
  changeGroupType: ChangeGroupType;
  source: PageVersionSource;
  metadata?: Record<string, unknown>;
}

export interface PageUpdateWithRevisionOptions {
  userId?: string | null;
  changeGroupId?: string;
  changeGroupType?: ChangeGroupType;
  source?: PageVersionSource;
  metadata?: Record<string, unknown>;
}

export interface PageMutationMeta {
  pageId: string;
  nextRevision: number;
  stateHashBefore: string;
  stateHashAfter: string;
  contentRefAfter: string | null;
  contentSizeAfter: number | null;
  contentFormatAfter: PageContentFormat;
  mentionsResult?: SyncMentionsResult;
}

export interface PageChangeResult {
  restoredValues: Record<string, unknown>;
  pageMutationMeta: PageMutationMeta | undefined;
}
