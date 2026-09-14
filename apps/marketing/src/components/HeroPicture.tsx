import type { CSSProperties } from "react";
import { getImageProps } from "next/image";
import { preload } from "react-dom";
import { HERO_FORMATS, HERO_FRAMES, heroLoader, type HeroFrame } from "@/lib/hero-images";

interface HeroPictureProps {
  frame: HeroFrame;
  sizes: string;
  className?: string;
  style?: CSSProperties;
  /** Preload the AVIF srcset. Only one frame can be the LCP candidate. */
  preloadAvif?: boolean;
}

/**
 * A hero backdrop as a <picture> over the files scripts/encode-hero.ts writes
 * at build time: AVIF where the browser supports it, WebP otherwise. It never
 * touches /_next/image, so the server does no encoding for it. getImageProps
 * still supplies the fill styles, the blur placeholder, and a srcset over
 * next/image's widths, each of which resolves to an encoded file.
 *
 * Unlike <Image>, getImageProps has no load state, so the blur placeholder stays
 * painted under the loaded image. That is invisible only because the sources
 * are opaque and cover the box: keep them free of transparency.
 */
export function HeroPicture({ frame, sizes, className, style, preloadAvif = false }: HeroPictureProps) {
  const { source, blurDataURL } = HERO_FRAMES[frame];
  const common = { src: `/${source}`, alt: "", fill: true, sizes } as const;

  const avif = getImageProps({ ...common, loader: heroLoader(frame, "avif") }).props;
  const { props: img } = getImageProps({
    ...common,
    loader: heroLoader(frame, "webp"),
    className,
    style,
    loading: "eager",
    fetchPriority: "high",
    placeholder: "blur",
    blurDataURL,
  });

  if (preloadAvif && avif.srcSet) {
    // `type` scopes the preload to browsers that will actually use the AVIF.
    preload(avif.src, {
      as: "image",
      imageSrcSet: avif.srcSet,
      imageSizes: sizes,
      type: HERO_FORMATS.avif.mimeType,
      fetchPriority: "high",
    });
  }

  return (
    <picture>
      <source type={HERO_FORMATS.avif.mimeType} srcSet={avif.srcSet} sizes={sizes} />
      <img {...img} alt="" />
    </picture>
  );
}
