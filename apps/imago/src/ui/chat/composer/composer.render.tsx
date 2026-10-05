import type { KeyboardEvent, ReactNode, Ref } from 'react';
import type { ChatDensity } from '../../frame/stage/stage';
import { Icon } from '../../components/icon/icon';
import {
  composerActionsClass,
  composerEntryClass,
  composerFieldClass,
  composerFormClass,
  composerSendClass,
  composerShellClass,
} from './composer-class';

export type ComposerRenderProps = {
  readonly draft: string;
  /** The field's name: who the message goes to. */
  readonly label: string;
  readonly placeholder: string;
  readonly density: ChatDensity;
  /** A reply is streaming: Send becomes Stop. */
  readonly streaming: boolean;
  /** Nowhere to send yet (no agent): Send stays off. */
  readonly disabled: boolean;
  /** Void action: commits the typed draft to the shell state. */
  readonly typeDraft: (draft: string) => void;
  readonly send: () => void;
  readonly stop: () => void;
  /** The field, for the container to put the caret back in it. */
  readonly fieldRef?: Ref<HTMLTextAreaElement>;
};

/**
 * Enter sends and Shift+Enter breaks the line. Enter that confirms an IME
 * composition (Safari reports it as keyCode 229) belongs to the composition.
 */
const sendsOnEnter = (event: KeyboardEvent<HTMLTextAreaElement>): boolean =>
  event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229;

/**
 * The floating composer (DEC-7: send, stop and draft only). The draft lives
 * in shell state, so it outlasts navigation and the pane itself; while a
 * reply streams it stays editable, and Stop stands where Send was.
 */
export function renderComposer(props: ComposerRenderProps): ReactNode {
  const { draft, label, placeholder, density, streaming, disabled, typeDraft, send, stop, fieldRef } = props;
  const canSend = !disabled && !streaming && draft.trim() !== '';
  return (
    <form
      className={composerFormClass}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) send();
      }}
    >
      <div className={composerShellClass(density)}>
        <div className={composerEntryClass}>
          <textarea
            ref={fieldRef}
            value={draft}
            placeholder={placeholder}
            aria-label={label}
            className={composerFieldClass(density)}
            onChange={(event) => typeDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (!sendsOnEnter(event)) return;
              event.preventDefault();
              if (canSend) send();
            }}
          />
          <div className={composerActionsClass}>
            {streaming ? (
              <button type="button" className={composerSendClass} aria-label="Stop" onClick={stop}>
                <Icon name="stop" size={14} />
              </button>
            ) : (
              <button type="submit" className={composerSendClass} aria-label="Send" disabled={!canSend}>
                <Icon name="send" size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
