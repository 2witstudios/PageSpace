import { Fragment } from "react";
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

/** ParallelDrive trust mark shown between the two cards (Eric Elliott's OSS company). */
function ParallelDriveMark() {
  return (
    <a className="pd-mark" href="https://paralleldrive.com/" target="_blank" rel="noopener noreferrer" aria-label="Parallel Drive">
      <span className="pd-logo" aria-hidden="true" />
      <span className="pd-name">Parallel Drive</span>
    </a>
  );
}

/**
 * Quiet social-proof band: real social pull-quotes as cards, with the ParallelDrive
 * mark between them. Review JSON-LD for each quote lives in schema.tsx (AEO).
 */
export function TestimonialSection() {
  const pair = TESTIMONIALS.length === 2;
  return (
    <section className="quote-band">
      <div className="qwrap">
        {TESTIMONIALS.map((t, i) => (
          <Fragment key={t.handle}>
            <TestimonialCard t={t} />
            {pair && i === 0 ? <ParallelDriveMark /> : null}
          </Fragment>
        ))}
      </div>
    </section>
  );
}
