import { describe, it, expect } from 'vitest';
import {
  calculateResizeDimensions,
  getOutputMediaType,
  MAX_VISION_DIMENSION,
  MAX_IMAGE_SIZE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
} from './image-resize';

describe('image-resize', () => {
  describe('calculateResizeDimensions', () => {
    it('given an image smaller than max, should return original dimensions unchanged', () => {
      const result = calculateResizeDimensions(800, 600, 2048);
      expect(result).toEqual({ width: 800, height: 600, wasResized: false });
    });

    it('given an image exactly at max, should return original dimensions unchanged', () => {
      const result = calculateResizeDimensions(2048, 2048, 2048);
      expect(result).toEqual({ width: 2048, height: 2048, wasResized: false });
    });

    it('given a landscape image exceeding max width, should scale down preserving aspect ratio', () => {
      const result = calculateResizeDimensions(4096, 2048, 2048);
      expect(result).toEqual({ width: 2048, height: 1024, wasResized: true });
    });

    it('given a portrait image exceeding max height, should scale down preserving aspect ratio', () => {
      const result = calculateResizeDimensions(1500, 4000, 2048);
      expect(result).toEqual({ width: 768, height: 2048, wasResized: true });
    });

    it('given a square image exceeding max, should scale to max on both axes', () => {
      const result = calculateResizeDimensions(4000, 4000, 2048);
      expect(result).toEqual({ width: 2048, height: 2048, wasResized: true });
    });

    it('given a very small image, should not upscale', () => {
      const result = calculateResizeDimensions(100, 50, 2048);
      expect(result).toEqual({ width: 100, height: 50, wasResized: false });
    });
  });

  describe('getOutputMediaType', () => {
    it('given image/png, should preserve as PNG', () => {
      expect(getOutputMediaType('image/png')).toBe('image/png');
    });

    it('given image/gif, should output as PNG to preserve transparency', () => {
      expect(getOutputMediaType('image/gif')).toBe('image/png');
    });

    it('given image/jpeg, should output as JPEG', () => {
      expect(getOutputMediaType('image/jpeg')).toBe('image/jpeg');
    });

    it('given image/webp, should output as JPEG for broader compatibility', () => {
      expect(getOutputMediaType('image/webp')).toBe('image/jpeg');
    });
  });

  describe('constants', () => {
    it('should export expected default values', () => {
      expect(MAX_VISION_DIMENSION).toBe(2048);
      expect(MAX_IMAGE_SIZE_BYTES).toBe(4 * 1024 * 1024);
      expect(MAX_IMAGES_PER_MESSAGE).toBe(5);
    });
  });
});
