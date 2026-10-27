"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Renders children at a fixed design size and scales the whole thing down to fit
 * the available width, preserving aspect ratio — so a desktop-proportioned mock
 * looks right (just smaller) on a narrow card instead of reflowing. Used for the
 * carousel page-type cards; the hero uses ScaledAppWindow (which exempts desktop
 * so the window can bleed).
 */
export function ScaledFrame({ designWidth, designHeight, children }: { designWidth: number; designHeight: number; children: ReactNode }) {
  const outerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    const compute = () => setScale(Math.min(1, outer.clientWidth / designWidth));
    const ro = new ResizeObserver(compute);
    ro.observe(outer);
    compute();
    return () => ro.disconnect();
  }, [designWidth]);

  // Height comes from CSS aspect-ratio (width-driven), not JS — so every slide is
  // the exact same height instantly, and the container never resizes as the JS
  // scale settles or slides change (no layout shift on the rest of the page).
  // The scaled inner is absolutely positioned so its fixed design width can't
  // force the flex slide wider than the available space (min-content trap).
  return (
    <div ref={outerRef} style={{ position: "relative", width: "100%", aspectRatio: `${designWidth} / ${designHeight}`, overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, left: 0, width: designWidth, height: designHeight, transformOrigin: "top left", transform: `scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}
