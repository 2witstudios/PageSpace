import type { ReactNode, Ref } from 'react';
import { Icon } from '../icon/icon';
import { inlineAddFieldClass, inlineAddRestClass } from './inline-add-class';

export type InlineAddRenderProps = {
  readonly open: boolean;
  readonly draft: string;
  /** The resting control's text, such as "Add subtask"; names the field too. */
  readonly label: string;
  readonly placeholder: string;
  /** The resting button, so focus can return to it after Escape. */
  readonly restRef?: Ref<HTMLButtonElement>;
  readonly startAdding: () => void;
  readonly typeDraft: (draft: string) => void;
  readonly commitDraft: () => void;
  readonly cancelAdding: () => void;
  readonly leaveField: () => void;
};

/**
 * PageSpace's inline add: a quiet "+ Add" button that becomes a field.
 * Enter commits (unless it confirms an IME composition), Escape cancels.
 */
export function renderInlineAdd({
  open,
  draft,
  label,
  placeholder,
  restRef,
  startAdding,
  typeDraft,
  commitDraft,
  cancelAdding,
  leaveField,
}: InlineAddRenderProps): ReactNode {
  if (!open)
    return (
      <button type="button" ref={restRef} className={inlineAddRestClass} onClick={startAdding}>
        <Icon name="plus" />
        {label}
      </button>
    );
  return (
    <input
      // The field only exists because the viewer just asked for it.
      autoFocus
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      className={inlineAddFieldClass}
      onChange={(event) => typeDraft(event.currentTarget.value)}
      onBlur={leaveField}
      onKeyDown={(event) => {
        // Safari confirms a composition with an Enter whose isComposing is
        // false; its keyCode is still 229.
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          commitDraft();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelAdding();
        }
      }}
    />
  );
}
