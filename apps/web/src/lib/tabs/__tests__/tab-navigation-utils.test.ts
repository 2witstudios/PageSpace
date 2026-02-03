/**
 * Tab Navigation Utilities Tests
 * Utilities for handling navigation with modifier keys
 */

import { describe, it, expect } from 'vitest';
import {
  isNewTabClick,
  isMiddleClick,
  shouldOpenInNewTab,
} from '../tab-navigation-utils';

describe('tab-navigation-utils', () => {
  describe('isNewTabClick', () => {
    it('given Cmd+click on Mac, should return true', () => {
      const event = { metaKey: true, ctrlKey: false } as React.MouseEvent;

      expect(isNewTabClick(event)).toBe(true);
    });

    it('given Ctrl+click, should return true', () => {
      const event = { metaKey: false, ctrlKey: true } as React.MouseEvent;

      expect(isNewTabClick(event)).toBe(true);
    });

    it('given regular click, should return false', () => {
      const event = { metaKey: false, ctrlKey: false } as React.MouseEvent;

      expect(isNewTabClick(event)).toBe(false);
    });

    it('given Shift+click, should return false', () => {
      const event = { metaKey: false, ctrlKey: false, shiftKey: true } as React.MouseEvent;

      expect(isNewTabClick(event)).toBe(false);
    });
  });

  describe('isMiddleClick', () => {
    it('given middle mouse button (1), should return true', () => {
      const event = { button: 1 } as React.MouseEvent;

      expect(isMiddleClick(event)).toBe(true);
    });

    it('given left mouse button (0), should return false', () => {
      const event = { button: 0 } as React.MouseEvent;

      expect(isMiddleClick(event)).toBe(false);
    });

    it('given right mouse button (2), should return false', () => {
      const event = { button: 2 } as React.MouseEvent;

      expect(isMiddleClick(event)).toBe(false);
    });
  });

  describe('shouldOpenInNewTab', () => {
    it('given Cmd+click, should return true', () => {
      const event = { metaKey: true, ctrlKey: false, button: 0 } as React.MouseEvent;

      expect(shouldOpenInNewTab(event)).toBe(true);
    });

    it('given middle click, should return true', () => {
      const event = { metaKey: false, ctrlKey: false, button: 1 } as React.MouseEvent;

      expect(shouldOpenInNewTab(event)).toBe(true);
    });

    it('given regular left click, should return false', () => {
      const event = { metaKey: false, ctrlKey: false, button: 0 } as React.MouseEvent;

      expect(shouldOpenInNewTab(event)).toBe(false);
    });
  });
});
