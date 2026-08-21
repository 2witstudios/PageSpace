import { db } from '@pagespace/db/db';
import { eq, and, ne, or, desc } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { formTargets, type FormTarget, type FormFieldDef, type FormTargetStatus } from '@pagespace/db/schema/form-targets';
import { pageRepository } from '@pagespace/lib/repositories/page-repository';
import { PageType } from '@pagespace/lib/utils/enums';
import {
  isSheetType,
} from '@pagespace/lib/sheets/sheet';
import { generateToken, hashToken } from '@pagespace/lib/auth/token-utils';
import { buildHeaderRowUpdates, buildSubmissionRowUpdates } from '@pagespace/lib/forms/cell-mapping';
import { setCells } from '@pagespace/lib/sheets/store';
import { createChangeGroupId } from '@pagespace/lib/monitoring/change-group';
import {
  logActivityWithTx,
  type DeferredWorkflowTrigger,
} from '@pagespace/lib/monitoring/activity-logger';
import type { PageMutationContext } from './page-mutation-service';

const FORM_TOKEN_PREFIX = 'pft';
const HEADER_ROW = 1;


export class FormTargetPageNotSheetError extends Error {}

/** Thrown when the target Sheet already has an active form target (enforced
 * by a partial unique index — see packages/db/src/schema/form-targets.ts).
 */
export class FormTargetAlreadyActiveError extends Error {}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

export interface CreateFormTargetInput {
  sheetPageId: string;
  fields: FormFieldDef[];
  createdBy: string;
  mutationContext: PageMutationContext;
  /** The Canvas page this target's HTML will be embedded in, if provisioned
   *  through the Forms settings UI. Omitted for AI-tool-provisioned targets
   *  that don't (yet) know which Canvas page will embed the form. */
  canvasPageId?: string;
  /** Optional email address to notify on each submission. Null/undefined = no notification. */
  notificationEmail?: string | null;
}

export interface CreateFormTargetResult {
  token: string;
  formTarget: FormTarget;
}

/**
 * Provisions a form target: writes the header row for `fields` onto the
 * target Sheet (via the existing page-mutation pipeline, so it's revisioned
 * and activity-logged like any other edit) and creates the form_targets
 * grant row in the SAME transaction — a failure after the header write (DB
 * error, connection drop, unique-hash collision) rolls back the header edit
 * too, instead of leaving an orphaned Sheet mutation with no grant.
 *
 * A Canvas page can have more than one form wired to it (landing pages
 * routinely have several — waitlist, contact, feedback), so canvasPageId is
 * NOT unique — see getFormTargetsByCanvasPageId.
 *
 * Throws FormTargetAlreadyActiveError if the sheet already has an active
 * form target (enforced by a partial unique index, not just app logic, so
 * two concurrent provisions can't both succeed and collide on `nextRow`).
 */
export async function createFormTarget({
  sheetPageId,
  fields,
  createdBy,
  mutationContext,
  canvasPageId,
  notificationEmail,
}: CreateFormTargetInput): Promise<CreateFormTargetResult> {
  const page = await pageRepository.findById(sheetPageId);
  if (!page) {
    throw new Error(`Page with ID "${sheetPageId}" not found`);
  }
  if (!isSheetType(page.type as PageType)) {
    throw new FormTargetPageNotSheetError(`Page "${sheetPageId}" is not a SHEET page`);
  }

  const generated = generateToken(FORM_TOKEN_PREFIX);

  try {
    const [formTarget] = await db.transaction(async (tx) => {
      // Writes the header cells directly. The read-modify-write of the whole
      // document that stood here could not express "set these cells" — it had
      // to reparse and re-serialise the entire sheet, and needed a guard
      // against an unreadable parse silently replacing the spreadsheet with
      // just these headers. Addressing cells removes the failure mode with the
      // code path.
      const headerGroupId = createChangeGroupId();

      await setCells(
        { pageId: page.id },
        buildHeaderRowUpdates(fields, HEADER_ROW),
        {
          userId: mutationContext.userId,
          actorEmail: mutationContext.actorEmail,
          changeGroupId: headerGroupId,
        },
        tx
      );

      // Provisioning a form overwrites row 1 of somebody's sheet. That used to
      // reach the page's activity timeline via `applyPageMutation`; without an
      // entry here it happened invisibly.
      await logActivityWithTx(
        {
          userId: mutationContext.userId,
          actorEmail: mutationContext.actorEmail ?? 'unknown@system',
          operation: 'update',
          resourceType: 'page',
          resourceId: page.id,
          resourceTitle: page.title ?? undefined,
          driveId: page.driveId,
          pageId: page.id,
          updatedFields: ['content'],
          changeGroupId: headerGroupId,
          changeGroupType: 'automation',
          metadata: { source: 'form-target-provision', headerRow: HEADER_ROW },
        },
        tx
      );

      return tx
        .insert(formTargets)
        .values({
          tokenHash: generated.hash,
          tokenPrefix: generated.tokenPrefix,
          driveId: page.driveId,
          pageId: page.id,
          action: 'sheet:append',
          canvasPageId,
          fields,
          headerRow: HEADER_ROW,
          nextRow: HEADER_ROW + 1,
          status: 'active',
          createdBy,
          notificationEmail: notificationEmail ?? null,
        })
        .returning();
    });

    return { token: generated.token, formTarget };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new FormTargetAlreadyActiveError(`Sheet "${sheetPageId}" already has an active form target`);
    }
    throw error;
  }
}

/**
 * Looks up a form target by its own id (owner-facing — e.g. to authorize a
 * status change against the target's pageId). Unlike lookupActiveFormTarget,
 * this returns any status, since a paused/archived target must still be
 * manageable by its owner.
 */
export async function getFormTargetById(formTargetId: string): Promise<FormTarget | null> {
  const [row] = await db
    .select()
    .from(formTargets)
    .where(eq(formTargets.id, formTargetId))
    .limit(1);
  return row ?? null;
}

/**
 * Looks up every form target wired to a given Canvas page — a page can have
 * several (a landing page routinely has a waitlist form, a contact form, a
 * feedback form, each wired independently). Returns any status (not just
 * active), same as getFormTargetById — the Forms settings tab must still
 * show a paused/archived target so it can be viewed. Ordered by createdAt
 * for a stable, deterministic list.
 */
export async function getFormTargetsByCanvasPageId(canvasPageId: string): Promise<FormTarget[]> {
  return db
    .select()
    .from(formTargets)
    .where(eq(formTargets.canvasPageId, canvasPageId))
    .orderBy(desc(formTargets.createdAt));
}

/**
 * Looks up a form target by its raw submit token. Returns null for BOTH an
 * unknown token and a paused/archived one — the caller (the public submit
 * route) must never be able to distinguish the two.
 */
export async function lookupActiveFormTarget(rawToken: string): Promise<FormTarget | null> {
  const hash = hashToken(rawToken);
  const [row] = await db
    .select()
    .from(formTargets)
    .where(and(eq(formTargets.tokenHash, hash), eq(formTargets.status, 'active')))
    .limit(1);
  return row ?? null;
}

export interface UpdateFormTargetStatusInput {
  formTargetId: string;
  status: FormTargetStatus;
  statusReason?: string;
}

/** Archiving is documented as permanent (see canvas-forms.md) — thrown when a
 *  caller tries to move an archived target back to active/paused. */
export class FormTargetArchivedError extends Error {}

/**
 * Updates a form target's status. Takes effect immediately: the public
 * submit route re-reads status on every request via lookupActiveFormTarget,
 * so there is no propagation delay or cache to invalidate.
 *
 * Archived is a terminal state — the WHERE clause excludes already-archived
 * rows from any non-archived target status, so a reactivation attempt
 * affects zero rows atomically (no separate read-then-check race) and is
 * reported as FormTargetArchivedError instead of silently reviving a form
 * the operator/AI agent explicitly retired.
 */
export async function updateFormTargetStatus({
  formTargetId,
  status,
  statusReason,
}: UpdateFormTargetStatusInput): Promise<FormTarget> {
  const [updated] = await db
    .update(formTargets)
    .set({ status, statusReason })
    .where(
      and(
        eq(formTargets.id, formTargetId),
        or(eq(formTargets.status, status), ne(formTargets.status, 'archived'))
      )
    )
    .returning();

  if (updated) {
    return updated;
  }

  const existing = await getFormTargetById(formTargetId);
  if (!existing) {
    throw new Error(`Form target "${formTargetId}" not found`);
  }
  throw new FormTargetArchivedError(
    `Form target "${formTargetId}" is archived — archiving is permanent and cannot be reversed`
  );
}

export interface UpdateFormTargetNotificationInput {
  formTargetId: string;
  notificationEmail: string | null;
}

/**
 * Updates a form target's notification email. Null clears it (disables
 * notifications). Takes effect immediately — the next submission reads the
 * updated value.
 */
export async function updateFormTargetNotification({
  formTargetId,
  notificationEmail,
}: UpdateFormTargetNotificationInput): Promise<FormTarget> {
  const [updated] = await db
    .update(formTargets)
    .set({ notificationEmail })
    .where(eq(formTargets.id, formTargetId))
    .returning();

  if (!updated) {
    throw new Error(`Form target "${formTargetId}" not found`);
  }

  return updated;
}

export interface AppendFormSubmissionInput {
  formTargetId: string;
  values: Record<string, string | boolean>;
  submitterIpHash: string;
}

/**
 * Appends one submission row. Locks the form_targets row (`FOR UPDATE`) so
 * concurrent submissions to THIS form serialize on `nextRow`; the page write
 * itself rides in the same transaction via `setCells`'s `tx` param, attributed
 * to the token's owning `createdBy` and grouped under the form target's id, so
 * it lands in the sheet change log like any other write rather than as a
 * bolt-on.
 *
 * There is no retry loop any more, and nothing to retry. It existed because
 * the append re-serialised the whole document under an `expectedRevision`
 * check, so a second form targeting the same sheet could lose the race and
 * need another attempt. Addressed cell writes do not contend: two forms
 * writing different rows of one sheet no longer conflict at all, and the
 * `FOR UPDATE` lock on `form_targets` already serialises submissions to the
 * same form so `nextRow` cannot be handed out twice.
 */
export async function appendFormSubmission({
  formTargetId,
  values,
  submitterIpHash,
}: AppendFormSubmissionInput): Promise<void> {
  let deferredTrigger: DeferredWorkflowTrigger | undefined;

  await db.transaction(async (tx) => {
    const [formTarget] = await tx
      .select()
      .from(formTargets)
      .where(eq(formTargets.id, formTargetId))
      .for('update');

    if (!formTarget) {
      throw new Error(`Form target "${formTargetId}" not found`);
    }

    const [page] = await tx.select().from(pages).where(eq(pages.id, formTarget.pageId)).limit(1);
    if (!page) {
      throw new Error(`Page "${formTarget.pageId}" not found`);
    }

    // One row write, not a rewrite of the sheet.
    //
    // This used to reparse the whole document, splice in the submitted row
    // and re-serialise all of it, which made a submission cost O(sheet) —
    // seconds of CPU once the sheet held tens of thousands of responses,
    // which is precisely when a form is working. The cells are addressed
    // directly now, so cost is independent of how many submissions came
    // before.
    const rowUpdates = buildSubmissionRowUpdates(formTarget.fields, formTarget.nextRow, values);
    // A change group per SUBMISSION, not per form.
    //
    // `activity-diff-utils` groups activities into one edit session by
    // (pageId, changeGroupId), and version resolution keys off the same pair.
    // Pinning the group to the form target id would collapse five thousand
    // submissions into a single history entry and leave version resolution
    // able to find only one of them. The form target belongs in metadata,
    // where it already is.
    const submissionGroupId = createChangeGroupId();

    await setCells(
      { pageId: page.id },
      rowUpdates,
      {
        userId: formTarget.createdBy,
        changeGroupId: submissionGroupId,
      },
      tx
    );

    await tx
      .update(formTargets)
      .set({
        nextRow: formTarget.nextRow + 1,
        submissionCount: formTarget.submissionCount + 1,
        lastSubmittedAt: new Date(),
      })
          .where(eq(formTargets.id, formTarget.id));

    // The submission's provenance still has to be recorded.
    //
    // It used to ride along in `applyPageMutation`'s activity log, which also
    // carried the whole document — the part we removed. The metadata is the
    // half that matters for an anonymous, publicly-reachable write: which form
    // took it, and the hashed IP it came from. Logged without any content
    // payload, and deliberately inside the transaction so a recorded
    // submission and a written row cannot disagree.
    // Returned so it can fire AFTER the commit. Dropping it — as this did —
    // silently stopped workflows wired to the target sheet from running on form
    // submissions: no error, just nothing happening.
    deferredTrigger = await logActivityWithTx(
      {
        userId: formTarget.createdBy,
        actorEmail: 'form-submission@system',
        operation: 'update',
        resourceType: 'page',
        resourceId: page.id,
        resourceTitle: page.title ?? undefined,
        driveId: page.driveId,
        pageId: page.id,
        updatedFields: ['content'],
        changeGroupId: submissionGroupId,
        changeGroupType: 'automation',
        metadata: {
          source: 'public-form-submission',
          formTargetId: formTarget.id,
          submitterIpHash,
          row: formTarget.nextRow,
        },
      },
      tx
    );
  });

  deferredTrigger?.();
}
