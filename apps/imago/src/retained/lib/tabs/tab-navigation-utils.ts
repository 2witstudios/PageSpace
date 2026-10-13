/**
 * Tab Navigation Utilities
 * Pure functions for handling navigation with modifier keys
 */

import type { MouseEvent } from 'react';

/**
 * Checks if the click event has Cmd (Mac) or Ctrl modifier
 */
export const isNewTabClick = (event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'>): boolean =>
  event.metaKey || event.ctrlKey;

/**
 * Checks if the event is a middle mouse button click
 */
export const isMiddleClick = (event: Pick<MouseEvent, 'button'>): boolean =>
  event.button === 1;

/**
 * Determines if the click should open in a new tab
 * (either Cmd/Ctrl+click or middle-click)
 */
export const shouldOpenInNewTab = (
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'button'>
): boolean => isNewTabClick(event) || isMiddleClick(event);
