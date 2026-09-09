"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Ico } from "./landing/icons";
import { PAGE_TYPES, MockCard } from "./landing/mocks";
import { ScaledFrame } from "./landing/ScaledFrame";
import { Carousel, CarouselContent, CarouselItem, type CarouselApi } from "@/components/ui/carousel";

// Every card is authored at this desktop size and scaled to fit its slide.
const CARD_W = 720;
const CARD_H = 434;

/**
 * "Everything is a page" — the nine page types as an Embla carousel. Embla owns
 * centering, the selected-snap index, and click-to-scroll, so the tab chips (the
 * only control) always match the centered card.
 */
export function PageTypeCarouselSection() {
  const [api, setApi] = useState<CarouselApi>();
  const [current, setCurrent] = useState(0);
  const hoveringRef = useRef(false);
  const focusWithinRef = useRef(false);
  const pausedUntil = useRef(0);

  // Keep the active index in sync with the centered slide.
  useEffect(() => {
    if (!api) return;
    const onSelect = () => setCurrent(api.selectedScrollSnap());
    onSelect();
    api.on("select", onSelect);
    api.on("reInit", onSelect);
    return () => {
      api.off("select", onSelect);
      api.off("reInit", onSelect);
    };
  }, [api]);

  // Gentle autoplay: advance every 5s, paused on hover/focus/drag and for ~9s
  // after any manual navigation. Disabled under reduced-motion.
  useEffect(() => {
    if (!api) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => {
      if (hoveringRef.current || focusWithinRef.current || Date.now() < pausedUntil.current) return;
      api.scrollNext();
    }, 5000);
    const onPointerDown = () => {
      pausedUntil.current = Date.now() + 9000;
    };
    api.on("pointerDown", onPointerDown);
    return () => {
      window.clearInterval(id);
      api.off("pointerDown", onPointerDown);
    };
  }, [api]);

  const goTo = useCallback(
    (i: number) => {
      pausedUntil.current = Date.now() + 9000;
      api?.scrollTo(i);
    },
    [api],
  );

  const active = PAGE_TYPES[current];

  return (
    <section className="band" id="pages">
      <div className="wrap">
        <div className="center">
          <h2 className="sec">Everything is a page</h2>
          <p className="sub">Documents, channels, agents, sheets, task lists, and code are one primitive in one tree. Where a page sits is what the AI knows about it.</p>
        </div>

        <div className="tabs" role="tablist" aria-label="Page types">
          {PAGE_TYPES.map((t, i) => (
            <button key={t.id} className="tab" role="tab" aria-selected={i === current} onClick={() => goTo(i)} type="button">
              <Ico name={t.icon} />
              {t.label}
            </button>
          ))}
        </div>

        <Carousel
          className="carousel"
          setApi={setApi}
          opts={{ align: "center", loop: true }}
          onMouseEnter={() => (hoveringRef.current = true)}
          onMouseLeave={() => (hoveringRef.current = false)}
          onFocusCapture={() => (focusWithinRef.current = true)}
          onBlurCapture={(event) => {
            // Only clear when focus actually leaves the carousel, not when it
            // moves between slides/controls inside it.
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              focusWithinRef.current = false;
            }
          }}
        >
          <CarouselContent className="carousel-track -ml-6">
            {PAGE_TYPES.map((t, i) => (
              <CarouselItem key={t.id} className="slide basis-[86%] max-w-[720px] pl-6" data-active={i === current} aria-hidden={i !== current} aria-label={t.label}>
                <ScaledFrame designWidth={CARD_W} designHeight={CARD_H}>
                  <MockCard type={t} />
                </ScaledFrame>
              </CarouselItem>
            ))}
          </CarouselContent>
        </Carousel>

        <div className="caption"><b>{active.label}.</b> {active.desc}</div>
      </div>
    </section>
  );
}
