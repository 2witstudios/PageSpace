import Image from "next/image";
import { Ico } from "./landing/icons";
import { TESTIMONIALS, type Testimonial } from "./landing/testimonial-data";

function TestimonialCard({ t }: { t: Testimonial }) {
  return (
    <a className="post" href={t.url} target="_blank" rel="noopener noreferrer">
      <div className="head">
        <Image className="ee-pic" src={t.avatar} alt={t.author} width={44} height={44} />
        <span className="who2">
          <span className="nm">{t.author}</span>
          <span className="hd">{t.handle}</span>
        </span>
        <span className="plat" aria-label="View post">
          <Ico name="arrowUpRight" size="i18" />
        </span>
      </div>
      <p className="text">{t.quote}</p>
      {t.credential ? (
        <div className="foot">
          <Ico name={t.credential.icon} size="i14" style={{ color: "var(--primary)" }} />
          <span>{t.credential.text}</span>
        </div>
      ) : null}
    </a>
  );
}

/**
 * Quiet social-proof band: real social pull-quotes as cards. Review JSON-LD for
 * each quote lives in schema.tsx (AEO: machine-readable social proof).
 */
export function TestimonialSection() {
  return (
    <section className="quote-band">
      <div className="qwrap">
        {TESTIMONIALS.map((t) => (
          <TestimonialCard t={t} key={t.handle} />
        ))}
      </div>
    </section>
  );
}
