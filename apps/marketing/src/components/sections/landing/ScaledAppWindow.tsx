"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Keeps the hero app window whole on every screen. The window is laid out at a
 * fixed design width (960px side-by-side from 1100px, 760px stacked below) so
 * all three panes stay visible, then scaled down to fit the box landing.css
 * reserves for it — so a 13" laptop and a phone both show the full product,
 * not a window cut off at the chat pane. The CSS reservation means the server
 * HTML already has the final height; this component only adds the transform.
 */
export function ScaledAppWindow({
  children,
  designWidth = 760,
  desktopDesignWidth = 960,
}: {
  children: ReactNode;
  designWidth?: number;
  desktopDesignWidth?: number;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [outerHeight, setOuterHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    const desktop = window.matchMedia("(min-width: 1100px)");

    const compute = () => {
      const design = desktop.matches ? desktopDesignWidth : designWidth;
      const available = outer.clientWidth;
      const next = Math.min(1, available / design);
      setScale(next);
      setOuterHeight(next < 1 ? inner.offsetHeight * next : undefined);
    };

    const ro = new ResizeObserver(compute);
    ro.observe(outer);
    ro.observe(inner);
    desktop.addEventListener("change", compute);
    compute();
    return () => {
      ro.disconnect();
      desktop.removeEventListener("change", compute);
    };
  }, [designWidth, desktopDesignWidth]);

  const scaled = scale !== 1;

  return (
    <div ref={outerRef} className="appwin-outer" style={{ height: outerHeight }}>
      <div
        ref={innerRef}
        className="appwin-inner"
        style={
          scaled
            ? {
                width: window.matchMedia("(min-width: 1100px)").matches ? desktopDesignWidth : designWidth,
                transformOrigin: "top left",
                transform: `scale(${scale})`,
              }
            : undefined
        }
      >
        {children}
      </div>
    </div>
  );
}
