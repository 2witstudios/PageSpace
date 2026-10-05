import { useEffect, useRef, useState, type RefObject } from 'react';

export type Disclosure = {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  /** Attach to the `<details>` element the menu lives in. */
  readonly ref: RefObject<HTMLDetailsElement | null>;
};

/**
 * A native `<details>` menu that closes as a menu would: on Escape (focus
 * goes back to its summary, since the item it was on is about to hide) and
 * on a press anywhere outside it. Each of the rail's menus owns one, so
 * opening one and pressing in another closes the first.
 */
export function useDisclosure(): Disclosure {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      ref.current?.querySelector<HTMLElement>(':scope > summary')?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return { open, setOpen, ref };
}
