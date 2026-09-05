import Image from "next/image";
import { Ico } from "./landing/icons";
import { TESTIMONIAL } from "./landing/testimonial-data";

/**
 * Quiet social-proof band: a real Threads post as a pull-quote card. The Review
 * JSON-LD for this quote lives in schema.tsx (AEO: machine-readable social proof).
 */
export function TestimonialSection() {
  return (
    <section className="quote-band">
      <div className="qwrap">
        <a className="post" href={TESTIMONIAL.url} target="_blank" rel="noopener noreferrer">
          <div className="head">
            <Image className="ee-pic" src="/eric-elliott.jpg" alt={TESTIMONIAL.author} width={44} height={44} />
            <span className="who2">
              <span className="nm">{TESTIMONIAL.author}</span>
              <span className="hd">{TESTIMONIAL.handle}</span>
            </span>
            <span className="plat" aria-label="Posted on Threads">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.742-1.762-.53-.622-1.418-.958-2.637-.958-.977 0-1.786.267-2.402.79l-1.36-1.53C9.606 6.766 10.837 6.34 12.24 6.34c1.71 0 3.02.51 3.9 1.514.79.902 1.208 2.19 1.243 3.826.023.02.046.04.068.06 1.352.802 2.34 2.01 2.86 3.492.72 2.056.786 5.41-1.93 8.067C16.6 23.15 14.526 23.977 12.186 24z" />
              </svg>
            </span>
          </div>
          <p className="text">
            <span className="lnk">PageSpace.ai</span> by <span className="lnk">@jono_minh</span> is not just my favorite AI tool — it&rsquo;s my favorite productivity software of all time. Imagine Slack, Notion, Trello, and Claude Code all fused into one product, in an agent-first environment.
          </p>
          <div className="foot">
            <Ico name="webby" size="i14" style={{ color: "var(--primary)" }} />
            <span>Webby-nominated author of <em>Composing Software</em></span>
          </div>
        </a>
      </div>
    </section>
  );
}
