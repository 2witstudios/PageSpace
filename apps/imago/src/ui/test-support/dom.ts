import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = { readonly container: HTMLElement; readonly root: Root };

const mounted: Mounted[] = [];

/** Mounts a tree into a container attached to the document, so focus works. */
export const mount = (tree: ReactNode): HTMLElement => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  act(() => {
    root.render(tree);
  });
  return container;
};

/** Unmounts everything `mount` attached; call from afterEach. */
export const unmountAll = (): void => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
};

/** Types into a controlled input or textarea the way the browser does: set, then `input`. */
export const typeInto = (input: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
  const setValue = Object.getOwnPropertyDescriptor(
    input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    'value',
  )?.set;
  act(() => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

/**
 * Presses a key on the given element; returns whether it was cancelled.
 * `keyCode` is for IME cases: Safari confirms a composition with 229.
 */
export const press = (target: Element, key: string, init: { readonly keyCode?: number } = {}): boolean => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
};

export const click = (target: HTMLElement): void => {
  act(() => {
    target.click();
  });
};

/**
 * Moves focus off an element inside act(), so React has applied the blur's
 * update before the test reads the DOM. A bare blur() leaves it pending.
 */
export const blur = (target: HTMLElement): void => {
  act(() => {
    target.blur();
  });
};
