"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Keeps the hero app window whole on small screens. On desktop (>=900px) it
 * renders the window as-is (it bleeds off the right by design). Below that it
 * lays the window out at a fixed design width so all three panes stay visible,
 * then scales it down to fit the container — so mobile shows the full product,
 * not just the document pane.
 */
export function ScaledAppWindow({ children, designWidth = 760 }: { children: ReactNode; designWidth?: number }) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [outerHeight, setOuterHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    const desktop = window.matchMedia("(min-width: 900px)");

    const compute = () => {
      if (desktop.matches) {
        setScale(1);
        setOuterHeight(undefined);
        return;
      }
      const available = outer.clientWidth;
      const next = Math.min(1, available / designWidth);
      setScale(next);
      setOuterHeight(inner.offsetHeight * next);
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
  }, [designWidth]);

  const scaled = scale !== 1;

  return (
    <div ref={outerRef} className="appwin-outer" style={{ height: outerHeight }}>
      <div
        ref={innerRef}
        className="appwin-inner"
        style={scaled ? { width: designWidth, transformOrigin: "top left", transform: `scale(${scale})` } : undefined}
      >
        {children}
      </div>
    </div>
  );
}
