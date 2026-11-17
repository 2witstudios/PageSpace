import { pgTable, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';

/**
 * Content safety: the hash blocklist, the scan-verdict cache, and the case
 * record behind every takedown or report.
 *
 * NO FOREIGN KEYS — deliberately. Every reference to a user, page, drive or
 * case in these tables is a plain text ID. These rows exist for legal
 * preservation, so they must survive the things they point at: GDPR erasure
 * deletes the `users` row and relies on FK cascades to sweep the rest
 * (packages/lib/src/compliance/erasure), and a cascading or restricting FK here
 * would either destroy the evidence or block the erasure. With no FK, neither
 * can happen. Do not "tidy" these into `.references(...)`; the
 * content-safety schema test fails if you do.
 */

/** Why a hash is blocked. `csam` and `malware` are purged globally; see lib policy. */
export type ContentBlockCategory = 'csam' | 'malware' | 'illegal_other' | 'policy';

/** What put the hash on the blocklist. */
export type ContentBlockSource = 'admin' | 'hash_match' | 'report';

export type ContentScanVerdict = 'clean' | 'flagged' | 'error';

export type ContentCaseTargetType =
  | 'content_hash'
  | 'file'
  | 'page'
  | 'published_url'
  | 'user'
  | 'avatar'
  | 'drive';

/**
 * `open`: reported or part-way through a takedown (resumable).
 * `awaiting_evidence`: the hash is blocked, but nothing was deleted because the
 *   material must be preserved first and no evidence storage is configured.
 * `actioned`: every step of the takedown finished.
 * `dismissed`: closed with no action.
 */
export type ContentCaseStatus = 'open' | 'awaiting_evidence' | 'actioned' | 'dismissed';

/** Which takedown a case runs. Stored on the snapshot so a rerun does the same thing. */
export type ContentTakedownKind = 'global' | 'unpublish_page' | 'park_drive' | 'avatar' | 'park_user_sites';

/** Why a drive's published sites are held off the public bucket. */
export type ContentSiteHoldSource = 'takedown' | 'user_suspension';

/**
 * Who and what was involved at the moment the case was opened, copied here so
 * it stays readable after the live rows are erased or deleted.
 */
export type ContentCaseSnapshot = {
  uploaderUserId?: string;
  driveIds?: string[];
  pageIds?: string[];
  ipAddress?: string;
  userAgent?: string;
  /** The takedown this case runs and the options it was started with (PR 2). */
  takedown?: {
    kind: ContentTakedownKind;
    actorUserId?: string;
    skipPreservation?: boolean;
    skipPreservationReason?: string;
    suspendUploader?: boolean;
  };
  /** Everything that referenced the hash when it was taken down. IDs only. */
  references?: {
    pageIds: string[];
    fileIds: string[];
    driveIds: string[];
    uploaderUserIds: string[];
    channelMessageIds: string[];
    directMessageIds: string[];
    aiMessageIds: string[];
    conversationIds: string[];
    /** True when a list hit its cap and is incomplete. */
    truncated: boolean;
    /**
     * The quick AI-message search could not finish, so `aiMessageIds` (and their authors) may be missing.
     * A takedown stores it with the references it records early (`record_references`), and drops it when the
     * mandatory search (`record_ai_references`, which fails and is retried rather than set this) rewrites the
     * references. So a finished case never carries it; a case still waiting at preservation can.
     */
    aiMessageScanFailed?: boolean;
  };
  /** Where the preserved copy is, when one was made. Bucket-relative key, never a URL. */
  evidenceKey?: string;
  /**
   * Further preserved copies, made when different bytes later appeared at the
   * same key (a re-sweep). The first verified copy is never overwritten.
   */
  additionalEvidenceKeys?: string[];
  /** An avatar takedown's preserved copies, one per avatar object, each named by its own checksum. */
  avatarEvidenceKeys?: string[];
  /** Re-sweep bookkeeping for a global takedown: passes attempted, and whether the last one finished. */
  resweep?: { attempts: number; done: boolean };
  [key: string]: unknown;
};

/** One recorded takedown step, so an interrupted takedown can resume (PR 2). */
export type ContentCaseStep = {
  step: string;
  status: 'ok' | 'skipped' | 'failed';
  detail?: string;
  at: string;
};

/** Hashes that must never be stored or served again. */
export const contentBlocks = pgTable(
  'content_blocks',
  {
    // Lowercase sha256 hex — the same value as `files.id`.
    contentHash: text('content_hash').primaryKey(),
    category: text('category').$type<ContentBlockCategory>().notNull(),
    source: text('source').$type<ContentBlockSource>().notNull(),
    // Plain text, no FK (see file header).
    caseId: text('case_id'),
    // Admin user ID. Plain text, no FK: the block outlives the admin's account.
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    caseIdx: index('content_blocks_case_id_idx').on(table.caseId),
  }),
);

/** Scan verdicts cached by hash. Filled by the publish gate (PR 4). */
export const contentScans = pgTable('content_scans', {
  contentHash: text('content_hash').primaryKey(),
  verdict: text('verdict').$type<ContentScanVerdict>().notNull(),
  provider: text('provider').notNull(),
  providerVersion: text('provider_version'),
  scores: jsonb('scores').$type<Record<string, unknown>>(),
  scannedAt: timestamp('scanned_at', { mode: 'date' }).notNull().defaultNow(),
});

/** The record behind every takedown or report. */
export const contentCases = pgTable(
  'content_cases',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),

    // Target. `targetId` is a hash, file/page/user ID or URL depending on
    // `targetType` — plain text, no FK (see file header).
    targetType: text('target_type').$type<ContentCaseTargetType>().notNull(),
    targetId: text('target_id').notNull(),
    contentHash: text('content_hash'),

    status: text('status').$type<ContentCaseStatus>().notNull().default('open'),
    // Null until triaged: a visitor's report doesn't arrive with a category.
    category: text('category').$type<ContentBlockCategory>(),

    // Reporter. Plain text, no FK; null for system-opened or anonymous cases.
    reporterUserId: text('reporter_user_id'),
    reporterContact: text('reporter_contact'),
    reason: text('reason'),

    snapshot: jsonb('snapshot').$type<ContentCaseSnapshot>(),
    steps: jsonb('steps').$type<ContentCaseStep[]>(),

    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => ({
    targetIdx: index('content_cases_target_idx').on(table.targetType, table.targetId),
    contentHashIdx: index('content_cases_content_hash_idx').on(table.contentHash),
    statusCreatedIdx: index('content_cases_status_created_at_idx').on(table.status, table.createdAt),
  }),
);

/**
 * Holds that keep a drive's published sites off the public bucket. The sites
 * are parked under `suspended/<prefix>/`, and these rows are what keep them
 * there: the visibility reconciler and every publish write consult them
 * (packages/lib/src/organizations/published-visibility.ts), so neither the retry
 * sweep nor a republish can put a held site back.
 *
 * A drive can be held more than once — by a takedown case AND by its owner's
 * suspension, or by two cases. Each holder owns one row (`holder` is
 * `case:<caseId>` or `user:<userId>`), lifting a hold removes only that row,
 * and the drive stays parked until its last hold is gone.
 *
 * Plain text IDs, no FK (see file header): a hold is part of the case record.
 */
export const contentSiteHolds = pgTable(
  'content_site_holds',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    driveId: text('drive_id').notNull(),
    holder: text('holder').notNull(),
    source: text('source').$type<ContentSiteHoldSource>().notNull(),
    caseId: text('case_id'),
    userId: text('user_id'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    driveHolderKey: uniqueIndex('content_site_holds_drive_holder_key').on(table.driveId, table.holder),
    userIdx: index('content_site_holds_user_id_idx').on(table.userId),
  }),
);

export type ContentBlock = typeof contentBlocks.$inferSelect;
export type NewContentBlock = typeof contentBlocks.$inferInsert;
export type ContentScan = typeof contentScans.$inferSelect;
export type NewContentScan = typeof contentScans.$inferInsert;
export type ContentCase = typeof contentCases.$inferSelect;
export type NewContentCase = typeof contentCases.$inferInsert;
export type ContentSiteHold = typeof contentSiteHolds.$inferSelect;
