import { db } from '@pagespace/db/db';
import { eq, and, ne, or, desc } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { formTargets, type FormTarget, type FormFieldDef, type FormTargetStatus } from '@pagespace/db/schema/form-targets';
import { pageRepository } from '@pagespace/lib/repositories/page-repository';
import { PageType } from '@pagespace/lib/utils/enums';
import {
  isSheetType,
  parseSheetContent,
  serializeSheetContent,
  updateSheetCells,
} from '@pagespace/lib/sheets/sheet';
import { generateToken, hashToken } from '@pagespace/lib/auth/token-utils';
import { buildHeaderRowUpdates, buildSubmissionRowUpdates } from '@pagespace/lib/forms/cell-mapping';
import { applyPageMutation, PageRevisionMismatchError, type PageMutationContext } from './page-mutation-service';

const FORM_TOKEN_PREFIX = 'pft';
const HEADER_ROW = 1;
const MAX_APPEND_ATTEMPTS = 3;

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
      const sheetData = parseSheetContent(page.content);
      const updatedSheet = updateSheetCells(sheetData, buildHeaderRowUpdates(fields, HEADER_ROW));
      const newContent = serializeSheetContent(updatedSheet, { pageId: page.id });

      await applyPageMutation({
        pageId: page.id,
        operation: 'update',
        updates: { content: newContent },
        updatedFields: ['content'],
        expectedRevision: typeof page.revision === 'number' ? page.revision : undefined,
        context: mutationContext,
        tx,
      });

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

export interface AppendFormSubmissionInput {
  formTargetId: string;
  values: Record<string, string | boolean>;
  submitterIpHash: string;
}

/**
 * Appends one submission row. Locks the form_targets row (`FOR UPDATE`) so
 * concurrent submissions to THIS form serialize on `nextRow`; the page write
 * itself rides in the same transaction via `applyPageMutation`'s `tx` param,
 * attributed to the token's owning `createdBy` with `changeGroupType:
 * 'automation'` so it's audit-logged like any other page mutation, not a
 * bolt-on log. Retries a bounded number of times on `PageRevisionMismatchError`
 * — a genuine edge case when a second form targets the same sheet.
 */
export async function appendFormSubmission({
  formTargetId,
  values,
  submitterIpHash,
}: AppendFormSubmissionInput): Promise<void> {
  for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt++) {
    try {
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

        const sheetData = parseSheetContent(page.content);
        const rowUpdates = buildSubmissionRowUpdates(formTarget.fields, formTarget.nextRow, values);
        const updatedSheet = updateSheetCells(sheetData, rowUpdates);
        const newContent = serializeSheetContent(updatedSheet, { pageId: page.id });

        await applyPageMutation({
          pageId: page.id,
          operation: 'update',
          updates: { content: newContent },
          updatedFields: ['content'],
          expectedRevision: typeof page.revision === 'number' ? page.revision : undefined,
          context: {
            userId: formTarget.createdBy,
            changeGroupType: 'automation',
            isAiGenerated: false,
            resourceType: 'page',
            metadata: {
              source: 'public-form-submission',
              formTargetId: formTarget.id,
              submitterIpHash,
            },
          },
          tx,
        });

        await tx
          .update(formTargets)
          .set({
            nextRow: formTarget.nextRow + 1,
            submissionCount: formTarget.submissionCount + 1,
            lastSubmittedAt: new Date(),
          })
          .where(eq(formTargets.id, formTarget.id));
      });
      return;
    } catch (error) {
      if (error instanceof PageRevisionMismatchError && attempt < MAX_APPEND_ATTEMPTS) {
        continue;
      }
      throw error;
    }
  }
}
