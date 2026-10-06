'use client';

import { useEffect, useRef, useState } from 'react';
import { renderInlineAdd } from './inline-add.render';

export type InlineAddProps = {
  /** The resting control's text, such as "Add subtask". */
  readonly label: string;
  readonly placeholder: string;
  /** Void action: adds the trimmed title. */
  readonly add: (title: string) => void;
};

/**
 * Enter adds and keeps the field open for the next one; Escape discards the
 * draft and hands focus back to the button; leaving an empty field closes it.
 */
export function InlineAdd({ label, placeholder, add }: InlineAddProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const restRef = useRef<HTMLButtonElement>(null);
  const refocusRest = useRef(false);

  useEffect(() => {
    if (open || !refocusRest.current) return;
    refocusRest.current = false;
    restRef.current?.focus();
  }, [open]);

  return renderInlineAdd({
    open,
    draft,
    label,
    placeholder,
    restRef,
    startAdding: () => setOpen(true),
    typeDraft: setDraft,
    commitDraft: () => {
      const title = draft.trim();
      if (title === '') return;
      add(title);
      setDraft('');
    },
    cancelAdding: () => {
      refocusRest.current = true;
      setDraft('');
      setOpen(false);
    },
    leaveField: () => {
      if (draft.trim() === '') setOpen(false);
    },
  });
}
