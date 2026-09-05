import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { APP_URL } from "@/lib/metadata";
import { Ico } from "./landing/icons";

/**
 * Hero — product-as-hero, split layout. Left: the single page <h1>, a quiet
 * answer block (AEO DAB, first 200 words), and one "Start free" CTA. Right: the
 * real app window. All titles inside the window are non-semantic (AEO single-H1).
 */
export function HeroSection() {
  return (
    <section className="hero">
      <div className="hero-in">
        <div className="hero-cap">
          <h1 className="hero-h">
            The AI for working<span className="dot">.</span>
          </h1>
          <p className="hero-sub">An AI coworker that actually does the work — everywhere your team already works.</p>
          {/* AEO answer block: self-contained, category terms, grounded specifics. */}
          <p className="hero-dab">
            <b>PageSpace is the AI-powered workspace platform where your team&rsquo;s work lives</b> — documents, tasks, channels, spreadsheets, and code, all as pages in one tree. Instead of a chatbot on the side, an AI coworker works inside it: writing docs, updating sheets, filing issues, and running tasks. Free on Mac, Windows, Linux, and iOS.
          </p>
          <div className="hero-cta">
            <Button size="lg" asChild>
              <a href={`${APP_URL}/auth/signup`}>
                Start free
                <ArrowRight className="ml-2 h-4 w-4" />
              </a>
            </Button>
            <span className="hero-plat">Free · Mac, Windows, Linux &amp; iOS</span>
          </div>
        </div>

        <div className="appwin">
          <div className="aw-top liquid-thin">
            <span className="aw-tbtn"><svg className="i i14" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /></svg></span>
            <span className="aw-tbtn" style={{ opacity: 0.35 }}><Ico name="chevL" size="i14" /></span>
            <span className="aw-tbtn" style={{ opacity: 0.35 }}><Ico name="chevR" size="i14" /></span>
            <span className="aw-tbtn"><svg className="i i14" viewBox="0 0 24 24" aria-hidden="true"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg></span>
            <span className="muted" style={{ fontSize: 12 }}>/</span>
            <div className="aw-search"><Ico name="search" size="i13" /><span style={{ flex: 1 }}>Search…</span><kbd>⌘K</kbd></div>
            <div style={{ flex: 1 }} />
            <span className="aw-tbtn"><svg className="i i14" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /></svg></span>
            <span className="aw-ava">JD</span>
          </div>
          <div className="aw-body">
            <div className="aw-side">
              <div className="aw-drive">
                <svg className="i i14" viewBox="0 0 24 24" aria-hidden="true" style={{ color: "var(--primary)" }}><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>
                My Workspace
                <svg className="i i14" viewBox="0 0 24 24" aria-hidden="true" style={{ marginLeft: "auto", color: "var(--muted-foreground)" }}><path d="m7 15 5 5 5-5M7 9l5-5 5 5" /></svg>
              </div>
              <div className="aw-nav"><svg className="i i14" viewBox="0 0 24 24" aria-hidden="true"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>Dashboard</div>
              <div className="aw-nav"><svg className="i i14" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5.5 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.5A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.5z" /></svg>Inbox<span className="b">3</span></div>
              <div className="aw-nav"><Ico name="task" size="i14" />Tasks</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0 6px" }}>
                <div style={{ position: "relative", flex: 1 }}>
                  <svg className="i i13" viewBox="0 0 24 24" aria-hidden="true" style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "var(--muted-foreground)" }}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
                  <div style={{ height: 30, border: "1px solid var(--border)", borderRadius: 8, background: "var(--background)", paddingLeft: 30, display: "flex", alignItems: "center", fontSize: 12, color: "var(--muted-foreground)" }}>Search pages…</div>
                </div>
                <span style={{ width: 30, height: 30, border: "1px solid var(--border)", borderRadius: 8, display: "grid", placeItems: "center", color: "var(--muted-foreground)", flex: "0 0 auto" }}><Ico name="plus" size="i14" /></span>
              </div>
              <div className="aw-tree on">
                <svg className="i i13" viewBox="0 0 24 24" aria-hidden="true" style={{ opacity: 0.5, transform: "rotate(90deg)" }}><path d="m9 18 6-6-6-6" /></svg>
                <Ico name="file" size="i14" />Q1 Planning
              </div>
              <div className="aw-tree" style={{ paddingLeft: 20 }}><Ico name="file" size="i14" />Product Roadmap<span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--primary)", marginLeft: 2 }} /></div>
              <div className="aw-tree" style={{ paddingLeft: 20 }}><Ico name="channel" size="i14" />Team Discussion</div>
              <div className="aw-tree pri">
                <svg className="i i13" viewBox="0 0 24 24" aria-hidden="true" style={{ opacity: 0.5 }}><path d="m9 18 6-6-6-6" /></svg>
                <Ico name="folder" size="i14" />Product Launch
              </div>
            </div>

            <div className="aw-main">
              <div className="aw-head">
                <div className="aw-crumb">My Workspace<Ico name="chevR" size="i13" /><span style={{ color: "var(--foreground)" }}>Q1 Planning</span></div>
                <div className="aw-title"><div className="h3">Q1 Planning</div><span className="aw-saved"><span className="g" />Saved</span></div>
              </div>
              <div className="aw-toolbar">
                <span className="aw-tb"><Ico name="bold" size="i13" /></span>
                <span className="aw-tb"><Ico name="italic" size="i13" /></span>
                <span className="aw-tb"><Ico name="strike" size="i13" /></span>
                <span className="aw-tb"><svg className="i i13" viewBox="0 0 24 24" aria-hidden="true"><path d="m16 18 6-6-6-6M8 6l-6 6 6 6" /></svg></span>
                <span className="aw-tsep" />
                <span className="aw-tb"><Ico name="h1" size="i13" /></span>
                <span className="aw-tb"><svg className="i i13" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h8M4 18V6M12 18V6" /><path d="M17 20c0-1.4 3-2.6 3-5 0-1.1-.9-2-2-2s-2 .9-2 2" /></svg></span>
                <span className="aw-tb on"><Ico name="pil" size="i13" /></span>
                <span className="aw-tsep" />
                <span className="aw-tb"><Ico name="list" size="i13" /></span>
                <span className="aw-tb"><svg className="i i13" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4l2-2.5V15a1 1 0 0 0-2 0" /></svg></span>
                <span className="aw-tb"><Ico name="quote" size="i13" /></span>
                <span className="aw-tsep" />
                <span className="aw-tb"><svg className="i i13" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></svg></span>
                <span style={{ flex: 1 }} />
                <span className="selchip" style={{ height: 26 }}>Sans<Ico name="chevD" size="i13" /></span>
                <span className="selchip" style={{ height: 26 }}>16px<Ico name="chevD" size="i13" /></span>
              </div>
              <div className="aw-doc">
                <div className="h1">Q1 Planning</div>
                <p>This document outlines our strategic priorities, key objectives, and execution timeline for the first quarter.</p>
                <div className="h2">Key Objectives</div>
                <ul>
                  <li>Launch the redesigned onboarding flow and measure activation</li>
                  <li>Expand AI agent capabilities with multi-model support</li>
                  <li>Achieve 95% uptime SLA and reduce p99 latency below 200ms</li>
                </ul>
                <blockquote>Focus is about saying no to the hundred other good ideas.</blockquote>
              </div>
            </div>

            <div className="aw-ai">
              <div className="aw-tabs">
                <span className="aw-tab on"><svg className="i i13" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z" /></svg>Chat</span>
                <span className="aw-tab"><svg className="i i13" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.7 9.7 0 0 0-6.7 2.9L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></svg>History</span>
                <span className="aw-tab"><svg className="i i13" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>Activity</span>
              </div>
              <div className="aw-conv">
                <div className="aw-you"><span className="n">You</span><p>Prep next week&rsquo;s launch from the spec.</p></div>
                <div className="aw-tool"><Ico name="chevR" size="i13" style={{ color: "var(--muted-foreground)" }} /><span className="nm">create_task</span><span className="ds">6 items</span><svg className="i i13 ok" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></div>
                <div className="aw-tool"><Ico name="chevR" size="i13" style={{ color: "var(--muted-foreground)" }} /><span className="nm">replace_lines</span><span className="ds">Launch Plan</span><svg className="i i13 ok" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></div>
                <div className="aw-tool"><Ico name="chevR" size="i13" style={{ color: "var(--muted-foreground)" }} /><span className="nm">gh_issue</span><span className="ds">#214</span><svg className="i i13 ok" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></div>
                <div className="aw-tool"><Ico name="chevR" size="i13" style={{ color: "var(--muted-foreground)" }} /><span className="nm">edit_sheet</span><span className="ds">Budget · B5</span><svg className="i i13 ok" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></div>
                <div className="aw-done">Done — created the checklist, updated the plan, filed the issue, and balanced the budget.</div>
              </div>
              <div className="aw-composer">
                <div className="r">Ask about this page…</div>
                <div className="f"><span className="model">Claude / Opus 4.6</span><span className="aw-send"><Ico name="send" size="i13" /></span></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
