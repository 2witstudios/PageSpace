'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getMetalEngine, type OrbMode } from '../metal-engine';
import { renderImagoOrb } from './imago-orb.render';
import type { OrbSize, OrbSurface } from './imago-orb-class';

export type ImagoOrbProps = {
  readonly size: OrbSize;
  /**
   * Live where Imago is present (the chat head, the empty chat, the thinking glyph, the Ask
   * buttons): it moves with Imago's mood. Still everywhere else, alive for a moment on hover.
   */
  readonly live?: boolean;
  readonly label?: string;
  readonly className?: string;
  /** A surface darker than the page (the spine): lit as on a dark page, so its rim reads bright. */
  readonly surface?: OrbSurface;
};

/** Imago, drawn as its liquid-metal orb wherever it shows up. */
export function ImagoOrb({ size, live = false, label, className, surface }: ImagoOrbProps): ReactNode {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [fallback, setFallback] = useState(false);
  const mode: OrbMode = live ? 'live' : 'still';
  useEffect(() => {
    const element = canvas.current;
    const engine = getMetalEngine();
    if (element === null) return;
    if (engine === null) {
      setFallback(true);
      return;
    }
    return engine.register(element, mode, setFallback);
  }, [mode]);
  return renderImagoOrb({ size, fallback, label, className, surface, canvasRef: canvas });
}
