import { describe, expect, it } from 'vitest';
import { getImageProps } from 'next/image';
import { imageConfigDefault } from 'next/dist/shared/lib/image-config';
import {
  HERO_URL_BASE,
  HERO_WIDTHS,
  heroLoader,
  heroVariantPath,
  heroVariantWidth,
  heroVariants,
} from '../hero-images';

const srcSetPaths = (srcSet: string | undefined) =>
  (srcSet ?? '').split(', ').map((entry) => entry.split(' ')[0]);

describe('hero image variants', () => {
  it('should encode every width next/image puts in a 100vw srcset', () => {
    // If Next's defaults change, a srcset entry would point at a file that was
    // never encoded and the hero would 404 at that viewport.
    expect([...HERO_WIDTHS]).toEqual(imageConfigDefault.deviceSizes);
  });

  it('should only reference encoded files from the srcset the hero actually renders', () => {
    const encoded = new Set(heroVariants().map((v) => v.path));
    for (const sizes of ['100vw', '1290px']) {
      const { props } = getImageProps({
        src: '/hero-space.webp',
        alt: '',
        fill: true,
        sizes,
        loader: heroLoader('dark', 'avif'),
      });
      const paths = srcSetPaths(props.srcSet);
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.filter((p) => !encoded.has(p))).toEqual([]);
    }
  });

  it('should round an unencoded width up to the next encoded one', () => {
    expect(heroVariantWidth(16)).toBe(640);
    expect(heroVariantWidth(1440)).toBe(1920);
    expect(heroVariantWidth(1920)).toBe(1920);
  });

  it('should fall back to the largest width above the largest encoded one', () => {
    expect(heroVariantWidth(5000)).toBe(3840);
  });

  it('should serve from the proxied marketing prefix', () => {
    expect(heroVariantPath('light', 750, 'webp')).toBe(`${HERO_URL_BASE}/light-750.webp`);
    expect(HERO_URL_BASE.startsWith('/_marketing/')).toBe(true);
  });

  it('should list one variant per frame, width and format', () => {
    const variants = heroVariants();
    expect(variants).toHaveLength(2 * HERO_WIDTHS.length * 2);
    expect(new Set(variants.map((v) => v.path)).size).toBe(variants.length);
  });
});
