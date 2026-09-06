import Image from "next/image";
import { Ico } from "./landing/icons";
import { TESTIMONIALS, type Testimonial } from "./landing/testimonial-data";

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function TestimonialCard({ t }: { t: Testimonial }) {
  const inner = (
    <>
      <div className="head">
        {t.avatar ? (
          <Image className="ee-pic" src={t.avatar} alt="" width={44} height={44} />
        ) : (
          <span className="ee-pic ee-init" aria-hidden="true">
            {initials(t.author)}
          </span>
        )}
        <span className="who2">
          <span className="nm">{t.author}</span>
          <span className="hd">{t.handle}</span>
        </span>
      </div>
      <p className="text">{t.quote}</p>
      {t.credential ? (
        <div className="foot">
          <Ico name={t.credential.icon} size="i14" style={{ color: "var(--primary)" }} />
          <span>{t.credential.text}</span>
        </div>
      ) : null}
    </>
  );
  return t.url ? (
    <a className="post" href={t.url} target="_blank" rel="noopener noreferrer">
      {inner}
    </a>
  ) : (
    <div className="post">{inner}</div>
  );
}

/**
 * Quiet social-proof band: real pull-quotes as cards. Review JSON-LD for
 * each quote lives in schema.tsx (AEO: machine-readable social proof).
 */
export function TestimonialSection() {
  return (
    <section className="quote-band">
      <div className="qwrap">
        {TESTIMONIALS.map((t) => (
          <TestimonialCard t={t} key={t.author} />
        ))}
      </div>
    </section>
  );
}
