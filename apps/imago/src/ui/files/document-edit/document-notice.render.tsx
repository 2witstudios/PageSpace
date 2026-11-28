import type { ReactNode } from 'react';
import { renderButton } from '../../components/button/button.render';
import type { SaveStatus } from './document-saver';
import { documentNoticeActionsClass, documentNoticeClass, documentSaveStateClass } from './document-edit-class';

export type DocumentNoticeProps = {
  readonly status: SaveStatus;
  /** Whether the viewer may edit: the quiet save state shows only then. */
  readonly editable: boolean;
  /** Settles a conflict by saving the viewer's text over the stored copy. */
  readonly onKeepMine: () => void;
  /** Settles a conflict by showing the stored copy instead. */
  readonly onUseStored: () => void;
  readonly onRetry: () => void;
  /** Why settling the conflict could not be done; null when it could. */
  readonly resolveError: string | null;
};

export const CONFLICT_NOTICE =
  'This page was changed somewhere else while you were editing. Your text is still here and has not been saved.';

export const REFUSED_NOTICE =
  'You can no longer edit this page, so your last changes were not saved. Copy anything you want to keep.';

export const DRAFT_RESTORED_NOTICE = 'The changes you had not saved when you left this page are back.';

/** Said once a document reopens with the draft it closed with. */
export function renderDraftRestored(): ReactNode {
  return (
    <p role="status" data-draft-restored="" className={documentSaveStateClass}>
      {DRAFT_RESTORED_NOTICE}
    </p>
  );
}

const SAVE_STATE: Readonly<Record<'saved' | 'unsaved' | 'saving', string>> = {
  saved: 'Saved',
  unsaved: 'Unsaved changes',
  saving: 'Saving…',
};

/** How the document's saving stands, and what the viewer can do when it needs them. */
export function renderDocumentNotice({
  status,
  editable,
  onKeepMine,
  onUseStored,
  onRetry,
  resolveError,
}: DocumentNoticeProps): ReactNode {
  if (status.kind === 'conflict') {
    return (
      <div role="alert" data-save-conflict="" className={documentNoticeClass}>
        <p>{CONFLICT_NOTICE}</p>
        {resolveError === null ? null : <p>{resolveError}</p>}
        <div className={documentNoticeActionsClass}>
          {renderButton({ variant: 'primary', onClick: onKeepMine, children: 'Keep my version' })}
          {renderButton({ variant: 'secondary', onClick: onUseStored, children: 'Use the saved version' })}
        </div>
      </div>
    );
  }
  if (status.kind === 'read-only') {
    return (
      <div role="alert" data-save-refused="" className={documentNoticeClass}>
        <p>{REFUSED_NOTICE}</p>
      </div>
    );
  }
  if (status.kind === 'failed') {
    return (
      <div role="alert" data-save-failed="" className={documentNoticeClass}>
        <p>{status.message}</p>
        <div className={documentNoticeActionsClass}>
          {renderButton({ variant: 'secondary', onClick: onRetry, children: 'Try again' })}
        </div>
      </div>
    );
  }
  if (!editable) return null;
  return (
    <p role="status" data-save-state={status.kind} className={documentSaveStateClass}>
      {SAVE_STATE[status.kind]}
    </p>
  );
}
