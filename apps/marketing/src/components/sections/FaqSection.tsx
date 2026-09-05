"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { Ico } from "./landing/icons";
import { FAQ_ITEMS } from "./landing/faq-data";

/**
 * Homepage FAQ (AEO): question-format H3s answering the top fan-out queries, with
 * real disclosure buttons (keyboard-operable). FAQPage JSON-LD lives in schema.tsx
 * and mirrors FAQ_ITEMS.
 */
export function FaqSection() {
  const [open, setOpen] = useState<number | null>(0);
  const baseId = useId();

  return (
    <section className="band" style={{ borderTop: "1px solid var(--border)" }}>
      <div className="wrap">
        <div className="center">
          <h2 className="sec">Questions, answered.</h2>
          <p className="sub">The quick version of what PageSpace is, what it costs, and who it&rsquo;s for.</p>
        </div>
        <div className="faq">
          {FAQ_ITEMS.map((item, i) => {
            const isOpen = open === i;
            const panelId = `${baseId}-faq-panel-${i}`;
            const btnId = `${baseId}-faq-btn-${i}`;
            return (
              <div className="faq-item" data-open={isOpen} key={item.q}>
                <button
                  type="button"
                  className="faq-q"
                  id={btnId}
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onClick={() => setOpen(isOpen ? null : i)}
                >
                  <h3>{item.q}</h3>
                  <Ico name="chevD" size="chev" />
                </button>
                <div className="faq-a" id={panelId} role="region" aria-labelledby={btnId} hidden={!isOpen}>
                  {item.a}
                  {item.link ? (
                    <>
                      {" "}
                      <Link href={item.link.href}>{item.link.label}</Link>.
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
