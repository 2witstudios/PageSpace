import type { ReactNode } from 'react';
import { renderIconButton } from '../../components/icon-button/icon-button.render';
import { renderSearchInput } from '../../components/search-input/search-input.render';
import { renderEmptyState } from '../../frame/edge-state/edge-state.render';
import { filesFilterClass, filesNoteClass, filesTreeClass } from './files-pane-class';

export type FilesPaneRenderProps = {
  readonly filter: string;
  /** Void action: commits the typed filter. */
  readonly typeFilter: (filter: string) => void;
  /** Why the last create failed, if it did. */
  readonly createError: string | null;
  /** The tree's `<li>` rows. */
  readonly rows: ReactNode;
  /** The drive holds no pages. */
  readonly empty: boolean;
  /** The filter kept nothing. */
  readonly noMatch: boolean;
};

const tree = ({ rows, empty, noMatch, filter }: FilesPaneRenderProps): ReactNode => {
  if (empty) return renderEmptyState({ title: 'No pages yet', detail: 'Pages in this drive show up here.' });
  if (noMatch) return <p className={filesNoteClass}>No pages match “{filter.trim()}”.</p>;
  return (
    <ul className={filesTreeClass} aria-label="File tree">
      {rows}
    </ul>
  );
};

/**
 * The Files section's list once the drive's tree loaded: a filter above the
 * page tree (one list, its levels nested), and why a create failed when one
 * did. A drive with no pages draws the designed empty state.
 */
export function renderFilesPane(props: FilesPaneRenderProps): ReactNode {
  const { filter, typeFilter, createError, empty } = props;
  return (
    <>
      {empty ? null : (
        <div className={filesFilterClass}>
          {renderSearchInput({ value: filter, placeholder: 'Filter files', label: 'Filter files', typeSearchQuery: typeFilter })}
        </div>
      )}
      {createError === null ? null : (
        <p role="alert" className={filesNoteClass}>
          {createError}
        </p>
      )}
      {tree(props)}
    </>
  );
}

export type NewPageButtonRenderProps = {
  /** Void action: creates a document where the selection says. */
  readonly create: () => void;
  /** Off until the drive's tree loads (nowhere to put it) and while a create is in flight. */
  readonly disabled: boolean;
};

/** + in the pane header: a new document in the selected folder. */
export function renderNewPageButton({ create, disabled }: NewPageButtonRenderProps): ReactNode {
  return renderIconButton({ name: 'plus', label: 'New page', disabled, onClick: create });
}
