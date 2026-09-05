"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Ico } from "./landing/icons";
import { PAGE_TYPES, MockCard } from "./landing/mocks";
import { ScaledFrame } from "./landing/ScaledFrame";

// Every card is authored at this desktop size and scaled to fit its slide, so
// the mocks keep correct UI proportions on any screen (see ScaledFrame).
const CARD_W = 720;
const CARD_H = 434;

/**
 * "Everything is a page" — the nine page types as an interactive carousel.
 * Scroll-snap track; programmatic goTo() disables snap during the smooth-scroll
 * and re-enables it only on scroll settle (avoids landing between two cards).
 */
export function PageTypeCarouselSection() {
  const stageRef = useRef<HTMLDivElement>(null);
  const slideRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [current, setCurrent] = useState(0);
  const currentRef = useRef(0);
  const pausedRef = useRef(false);
  const reduceRef = useRef(false);

  const setActive = useCallback((i: number) => {
    currentRef.current = i;
    setCurrent(i);
  }, []);

  const pauseAuto = useCallback(() => {
    pausedRef.current = true;
    window.setTimeout(() => {
      pausedRef.current = false;
    }, 9000);
  }, []);

  const goTo = useCallback(
    (i: number, user?: boolean) => {
      const n = PAGE_TYPES.length;
      i = ((i % n) + n) % n;
      const stage = stageRef.current;
      const s = slideRefs.current[i];
      if (!stage || !s) return;
      stage.style.scrollSnapType = "none";
      stage.scrollTo({ left: Math.round(s.offsetLeft - (stage.clientWidth - s.clientWidth) / 2), behavior: reduceRef.current ? "auto" : "smooth" });
      setActive(i);
      if (user) pauseAuto();
    },
    [setActive, pauseAuto],
  );

  // Track the nearest card on manual scroll; re-enable snap once scrolling settles.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    reduceRef.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let settle = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const c = stage.scrollLeft + stage.clientWidth / 2;
        let best = 0;
        let bestD = Infinity;
        slideRefs.current.forEach((s, k) => {
          if (!s) return;
          const cc = s.offsetLeft + s.clientWidth / 2;
          const d = Math.abs(cc - c);
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        });
        if (best !== currentRef.current) setActive(best);
      });
      window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        stage.style.scrollSnapType = "x mandatory";
      }, 150);
    };
    stage.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      stage.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
    };
  }, [setActive]);

  // Autoplay (paused on hover/focus/touch and after a manual move).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => {
      if (!pausedRef.current) goTo(currentRef.current + 1);
    }, 5200);
    const pause = () => {
      pausedRef.current = true;
    };
    const resume = () => {
      pausedRef.current = false;
    };
    (["mouseenter", "focusin", "touchstart"] as const).forEach((ev) => stage.addEventListener(ev, pause, { passive: true }));
    (["mouseleave", "focusout"] as const).forEach((ev) => stage.addEventListener(ev, resume));
    // Centre the first card on mount.
    goTo(0);
    return () => {
      window.clearInterval(timer);
      (["mouseenter", "focusin", "touchstart"] as const).forEach((ev) => stage.removeEventListener(ev, pause));
      (["mouseleave", "focusout"] as const).forEach((ev) => stage.removeEventListener(ev, resume));
    };
  }, [goTo]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      goTo(currentRef.current + 1, true);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      goTo(currentRef.current - 1, true);
    }
  };

  const active = PAGE_TYPES[current];

  return (
    <section className="band" id="pages">
      <div className="wrap">
        <div className="center">
          <h2 className="sec">Everything is a page</h2>
          <p className="sub">Documents, channels, agents, spreadsheets, task lists, code files — the same primitive in one tree. Where you place them shapes what the AI knows.</p>
        </div>

        <div className="tabs" role="tablist" aria-label="Page types">
          {PAGE_TYPES.map((t, i) => (
            <button
              key={t.id}
              className="tab"
              role="tab"
              aria-selected={i === current}
              onClick={() => goTo(i, true)}
              type="button"
            >
              <Ico name={t.icon} />
              {t.label}
            </button>
          ))}
        </div>

        <div className="stage" ref={stageRef} tabIndex={0} aria-roledescription="carousel" onKeyDown={onKeyDown}>
          {PAGE_TYPES.map((t, i) => (
            <div
              key={t.id}
              className={`slide${i === current ? " is-active" : ""}`}
              role="tabpanel"
              aria-label={t.label}
              ref={(el) => {
                slideRefs.current[i] = el;
              }}
            >
              <ScaledFrame designWidth={CARD_W} designHeight={CARD_H}>
                <MockCard type={t} />
              </ScaledFrame>
            </div>
          ))}
        </div>

        <div className="caption"><b>{active.label}</b> — {active.desc}</div>

        <div className="ctrls">
          <button className="arrow" aria-label="Previous page type" onClick={() => goTo(current - 1, true)} type="button">
            <Ico name="chevL" size="i20" />
          </button>
          <div className="dots" role="tablist" aria-label="Select page type">
            {PAGE_TYPES.map((t, i) => (
              <button
                key={t.id}
                className="dotb"
                role="tab"
                aria-label={t.label}
                aria-current={i === current}
                onClick={() => goTo(i, true)}
                type="button"
              />
            ))}
          </div>
          <button className="arrow" aria-label="Next page type" onClick={() => goTo(current + 1, true)} type="button">
            <Ico name="chevR" size="i20" />
          </button>
        </div>
      </div>
    </section>
  );
}
