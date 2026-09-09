"use client";

import { useLayoutEffect, type ReactNode } from "react";
import { useAnimate } from "motion/react";

/**
 * Plays the agent run the hero window already depicts.
 *
 * The window ships *finished*: this takes the server-rendered markup as
 * `children` (the same wrapping trick ScaledAppWindow uses, so none of that
 * markup moves into the client bundle) and only ever rewinds it on the client.
 * So the SSR HTML, the OG capture in scripts/capture-og.spec.ts, reduced-motion
 * users, and anyone whose JS fails all get today's design untouched — the
 * animation is a thing that happens *to* the rest state, never a thing the rest
 * state is assembled from.
 *
 * The rewind runs in a layout effect, before the browser paints, which is what
 * stops the finished window flashing ahead of the sequence.
 *
 * The tool rows carry the sequence and the document answers them; the sidebar
 * deliberately holds still. Flashing the tree rows each tool named was tried and
 * cut — on rows that small and that muted it reads as stray highlighting, not as
 * cause and effect.
 *
 * The window's *arrival* is not ours: landing.css's `lp-land` brings
 * .appwin-outer in as the last beat of the page's cinematic open, finishing at
 * ~2050ms. This picks up from there, so the run reads as the product doing
 * something once it has landed rather than as a second, competing entrance.
 */

/** The conversation's five tool rows, in order; this one rewrites the page. */
const TOOL_COUNT = 5;
const DOC_BEAT = 2; // Replace Lines · Launch Plan — the open page

// Keep in step with landing.css: .appwin-outer's lp-land is 900ms delay + 1150ms.
const WINDOW_LANDED = 2000;
const PROMPT_AT = WINDOW_LANDED;
const FIRST_TOOL_AT = WINDOW_LANDED + 400;
const BEAT_GAP = 520;
const CHECK_LAG = 300; // a check that lands with its row reads as pre-ticked
const EASE = [0.2, 0.7, 0.3, 1] as const; // the CTA's curve, reused

const RISE = "translateY(6px)";
const REST = "translateY(0px)";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function HeroDemo({ children }: { children: ReactNode }) {
  const [scope, animate] = useAnimate<HTMLDivElement>();

  useLayoutEffect(() => {
    const root = scope.current;
    if (!root) return;
    // Leave the rest state completely alone for anyone who asked for less
    // motion — same check the carousel autoplay uses. The rest state *is* the
    // finished frame, so still raise the done flag: it means "the hero is
    // showing its final state", which keeps the OG capture honest either way.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      root.dataset.demo = "done";
      return;
    }

    let cancelled = false;
    const all = (sel: string) => Array.from(root.querySelectorAll<HTMLElement>(sel));

    // --- Rewind, synchronously, before the first paint ------------------
    // Opacity and transform only: .aw-conv is a fixed-height overflow-hidden
    // column and .appwin-outer has a reserved aspect-ratio, so anything that
    // reflows here shows up as CLS.
    const hide = (sel: string, transform: string) => {
      for (const el of all(sel)) {
        el.style.opacity = "0";
        el.style.transform = transform;
      }
    };
    hide(".aw-you", RISE);
    hide(".aw-tool", RISE);
    hide(".aw-done", RISE);
    hide(".aw-doc > *", RISE);
    hide(".aw-tool .ok", "scale(0.4)");
    hide(".aw-saved .g", "scale(0)");

    // Explicit from/to keyframes throughout: the pre-set inline styles above are
    // what the browser paints first, and passing both ends means motion never
    // has to infer the start from a transform it did not write.
    const rise = (el: Element | undefined, duration = 0.28, delay = 0) => {
      if (!el) return;
      animate(
        el,
        { opacity: [0, 1], transform: [RISE, REST] },
        { duration, delay, ease: EASE },
      );
    };

    const play = async () => {
      await wait(PROMPT_AT);
      if (cancelled) return;
      rise(all(".aw-you")[0]);

      const tools = all(".aw-tool");
      await wait(FIRST_TOOL_AT - PROMPT_AT);

      for (let i = 0; i < TOOL_COUNT; i++) {
        if (cancelled) return;
        const row = tools[i];
        if (row) {
          rise(row);
          const ok = row.querySelector(".ok");
          if (ok) {
            animate(
              ok,
              { opacity: [0, 1], transform: ["scale(0.4)", "scale(1)"] },
              { duration: 0.3, delay: CHECK_LAG / 1000, ease: EASE },
            );
          }
        }
        if (i === DOC_BEAT) {
          // Blocks, not characters: a real typewriter on this much copy is both
          // janky and slow enough to blow the timeline, and staggered blocks
          // read as "being written" for a fraction of the cost.
          const blocks = all(".aw-doc > *");
          blocks.forEach((el, n) => rise(el, 0.32, CHECK_LAG / 1000 + n * 0.06));
          const dot = all(".aw-saved .g")[0];
          if (dot) {
            animate(
              dot,
              { opacity: [0, 1], transform: ["scale(0)", "scale(1)"] },
              {
                duration: 0.4,
                delay: CHECK_LAG / 1000 + blocks.length * 0.06,
                ease: [0.34, 1.56, 0.64, 1],
              },
            );
          }
        }
        await wait(BEAT_GAP);
      }

      if (cancelled) return;
      rise(all(".aw-done")[0]);
      await wait(500);
      if (cancelled) return;
      // The signal capture-og.spec.ts waits on, so the social card is always
      // shot on the finished frame rather than a fixed timeout's guess.
      root.dataset.demo = "done";
    };

    void play();

    return () => {
      cancelled = true;
    };
  }, [scope, animate]);

  return (
    <div ref={scope} className="hero-demo" data-demo="idle">
      {children}
    </div>
  );
}
