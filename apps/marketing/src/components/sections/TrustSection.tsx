import { Ico } from "./landing/icons";

/** "Full access, safely" — six grounded guardrails for an AI that acts. */
const TRUST: { icon: string; title: string; body: string }[] = [
  {
    icon: "users",
    title: "You control who sees what",
    body: "Role-based permissions down to the individual page, with custom roles and time-limited access. Everyone, and every agent, gets exactly the reach you grant.",
  },
  {
    icon: "sliders",
    title: "Scope every agent",
    body: "Choose each agent’s tools, its model, and the slice of your workspace it can touch. Powerful capabilities like the code sandbox stay off until you turn them on.",
  },
  {
    icon: "lock",
    title: "No back-door for AI",
    body: "Every AI action runs through the same permission checks as people. There is no privileged bypass, and it fails closed. An agent only ever has the access you gave it.",
  },
  {
    icon: "undo",
    title: "Every edit is reversible",
    body: "The AI snapshots a restore point before it touches anything. Roll back a page, a conversation, or the whole drive.",
  },
  {
    icon: "database",
    title: "Backed up, not just saved",
    body: "Scheduled and on-demand drive backups you can restore from, plus a trash that keeps deleted pages for 30 days before they’re purged.",
  },
  {
    icon: "shieldCheck",
    title: "Logged and encrypted",
    body: "A tamper-evident audit trail of who did what, field-level encryption for sensitive data, and GDPR export & erasure built in.",
  },
];

export function TrustSection() {
  return (
    <section className="band" style={{ borderTop: "1px solid var(--border)" }}>
      <div className="wrap">
        <div className="center">
          <h2 className="sec">Full access, with the brakes you set</h2>
          <p className="sub">Permissions, restore points, backups, and an audit trail apply to the AI exactly as they apply to people.</p>
        </div>
        <div className="tlist">
          {TRUST.map((t) => (
            <div className="trow" key={t.title}>
              <span className="ic"><Ico name={t.icon} size="i20" /></span>
              <div>
                <h3>{t.title}</h3>
                <p>{t.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
