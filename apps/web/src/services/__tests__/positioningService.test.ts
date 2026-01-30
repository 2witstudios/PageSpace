/**
 * positioningService Tests
 * Tests for positioning helper functions used in mention popups and overlays
 *
 * These tests validate observable behavior:
 * - getViewportHeight() returns correct viewport dimensions
 * - getKeyboardOffset() caches and returns keyboard height
 * - calculateInlinePosition() accounts for keyboard offset
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getViewportHeight,
  getKeyboardOffset,
  clearKeyboardOffsetCache,
  positioningService,
} from '../positioningService';

describe('getViewportHeight', () => {
  const originalVisualViewport = window.visualViewport;
  const originalInnerHeight = window.innerHeight;

  afterEach(() => {
    // Restore original values
    Object.defineProperty(window, 'visualViewport', {
      value: originalVisualViewport,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, 'innerHeight', {
      value: originalInnerHeight,
      writable: true,
      configurable: true,
    });
  });

  it('given visualViewport available, should return visualViewport.height', () => {
    Object.defineProperty(window, 'visualViewport', {
      value: { height: 600, width: 400 },
      writable: true,
      configurable: true,
    });

    expect(getViewportHeight()).toBe(600);
  });

  it('given visualViewport not available, should return innerHeight', () => {
    Object.defineProperty(window, 'visualViewport', {
      value: null,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, 'innerHeight', {
      value: 800,
      writable: true,
      configurable: true,
    });

    expect(getViewportHeight()).toBe(800);
  });
});

describe('getKeyboardOffset', () => {
  beforeEach(() => {
    clearKeyboardOffsetCache();
    document.body.style.removeProperty('--keyboard-height');
  });

  afterEach(() => {
    clearKeyboardOffsetCache();
    document.body.style.removeProperty('--keyboard-height');
  });

  it('given no --keyboard-height CSS variable, should return 0', () => {
    expect(getKeyboardOffset()).toBe(0);
  });

  it('given --keyboard-height CSS variable, should return height value', () => {
    document.body.style.setProperty('--keyboard-height', '280px');

    expect(getKeyboardOffset()).toBe(280);
  });

  it('given cached value within TTL, should return cached value without recomputing', () => {
    document.body.style.setProperty('--keyboard-height', '300px');

    // First call - populates cache
    const firstResult = getKeyboardOffset();
    expect(firstResult).toBe(300);

    // Change the CSS variable
    document.body.style.setProperty('--keyboard-height', '400px');

    // Second call within TTL - should return cached value
    const secondResult = getKeyboardOffset();
    expect(secondResult).toBe(300);
  });

  it('given cache expired, should read fresh value', async () => {
    document.body.style.setProperty('--keyboard-height', '300px');

    // First call - populates cache
    const firstResult = getKeyboardOffset();
    expect(firstResult).toBe(300);

    // Change the CSS variable
    document.body.style.setProperty('--keyboard-height', '400px');

    // Wait for cache to expire (TTL is 100ms)
    await new Promise((resolve) => setTimeout(resolve, 110));

    // Third call after TTL - should return new value
    const thirdResult = getKeyboardOffset();
    expect(thirdResult).toBe(400);
  });

  it('given clearKeyboardOffsetCache called, should read fresh value', () => {
    document.body.style.setProperty('--keyboard-height', '300px');

    // First call - populates cache
    const firstResult = getKeyboardOffset();
    expect(firstResult).toBe(300);

    // Change the CSS variable
    document.body.style.setProperty('--keyboard-height', '500px');

    // Clear cache
    clearKeyboardOffsetCache();

    // Next call should return new value
    const freshResult = getKeyboardOffset();
    expect(freshResult).toBe(500);
  });
});

describe('positioningService.calculateInlinePosition', () => {
  const originalGetSelection = window.getSelection;
  const originalVisualViewport = window.visualViewport;

  beforeEach(() => {
    clearKeyboardOffsetCache();
    document.body.style.removeProperty('--keyboard-height');

    // Mock visualViewport
    Object.defineProperty(window, 'visualViewport', {
      value: { height: 800, width: 400 },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    clearKeyboardOffsetCache();
    document.body.style.removeProperty('--keyboard-height');
    window.getSelection = originalGetSelection;
    Object.defineProperty(window, 'visualViewport', {
      value: originalVisualViewport,
      writable: true,
      configurable: true,
    });
  });

  it('given no selection, should fallback to element positioning', () => {
    window.getSelection = vi.fn(() => null);

    const element = document.createElement('div');
    element.getBoundingClientRect = vi.fn(() => ({
      top: 100,
      left: 50,
      bottom: 120,
      right: 200,
      width: 150,
      height: 20,
      x: 50,
      y: 100,
      toJSON: () => ({}),
    }));

    const result = positioningService.calculateInlinePosition({ element });

    expect(result.top).toBe(130); // rect.top + 30
    expect(result.left).toBe(70); // rect.left + 20
    expect(result.width).toBe(240);
  });

  it('given selection with enough space below, should position below cursor', () => {
    const mockRange = {
      getBoundingClientRect: vi.fn(() => ({
        top: 100,
        bottom: 120,
        left: 50,
        right: 60,
        width: 10,
        height: 20,
        x: 50,
        y: 100,
        toJSON: () => ({}),
      })),
    };

    window.getSelection = vi.fn(() => ({
      rangeCount: 1,
      getRangeAt: vi.fn(() => mockRange),
    })) as unknown as typeof window.getSelection;

    const element = document.createElement('div');

    const result = positioningService.calculateInlinePosition({ element });

    // Popup should be below cursor: cursorRect.bottom + gap
    expect(result.top).toBe(126); // 120 + 6
    expect(result.left).toBe(50);
    expect(result.width).toBe(240);
  });

  it('given keyboard open reducing available height, should position above cursor', () => {
    // Set keyboard height
    document.body.style.setProperty('--keyboard-height', '300px');
    clearKeyboardOffsetCache();

    // Cursor near the bottom of available space
    const mockRange = {
      getBoundingClientRect: vi.fn(() => ({
        top: 450,
        bottom: 470,
        left: 50,
        right: 60,
        width: 10,
        height: 20,
        x: 50,
        y: 450,
        toJSON: () => ({}),
      })),
    };

    window.getSelection = vi.fn(() => ({
      rangeCount: 1,
      getRangeAt: vi.fn(() => mockRange),
    })) as unknown as typeof window.getSelection;

    const element = document.createElement('div');

    const result = positioningService.calculateInlinePosition({ element });

    // Available height = 800 - 300 = 500
    // Below position would be 470 + 6 = 476
    // 476 + 240 = 716 > 500 - 20 = 480, so should flip above
    // Above position: cursorRect.top - popupHeight - gap = 450 - 240 - 6 = 204
    expect(result.top).toBe(204);
  });

  it('given cursor near right edge, should adjust left position', () => {
    const mockRange = {
      getBoundingClientRect: vi.fn(() => ({
        top: 100,
        bottom: 120,
        left: 350, // Near right edge (viewport is 400px wide)
        right: 360,
        width: 10,
        height: 20,
        x: 350,
        y: 100,
        toJSON: () => ({}),
      })),
    };

    window.getSelection = vi.fn(() => ({
      rangeCount: 1,
      getRangeAt: vi.fn(() => mockRange),
    })) as unknown as typeof window.getSelection;

    const element = document.createElement('div');

    const result = positioningService.calculateInlinePosition({ element });

    // Left should be adjusted: viewportWidth - popupWidth - 20 = 400 - 240 - 20 = 140
    expect(result.left).toBe(140);
  });
});
