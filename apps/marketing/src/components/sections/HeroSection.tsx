import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { APP_URL } from "@/lib/metadata";
import { Ico } from "./landing/icons";
import { ScaledAppWindow } from "./landing/ScaledAppWindow";

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
          <p className="hero-sub">Partner for any project, workspace for any team.</p>
          <div className="hero-cta">
            <a className="cta-primary" href={`${APP_URL}/auth/signup`}>
              Start free
              <span className="cta-arrow" aria-hidden="true">
                <ArrowRight />
              </span>
            </a>
            <Link className="hero-plat" href="/downloads">
              Also on desktop &amp; mobile
            </Link>
          </div>
        </div>

        <ScaledAppWindow>
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
              <div className="aw-nav"><svg className="i i14" viewBox="0 0 24 24" aria-hidden="true"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>Drive Home</div>
              <div className="aw-nav"><svg className="i i14" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>Direct Messages<span className="b">3</span></div>
              <div className="aw-nav"><svg className="i i14" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" /></svg>Channels<span className="b">2</span></div>
              <div className="aw-nav"><svg className="i i14" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>Files</div>
              <div className="aw-nav"><Ico name="task" size="i14" />Tasks</div>
              <div className="aw-nav"><svg className="i i14" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>Calendar</div>
              <div className="aw-nav"><Ico name="bot" size="i14" />Agents</div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 6px 4px", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--muted-foreground)" }}>
                Pages
                <span style={{ display: "grid", placeItems: "center", color: "var(--muted-foreground)" }}><Ico name="plus" size="i14" /></span>
              </div>
              <div className="aw-tree pri">
                <svg className="i i13" viewBox="0 0 24 24" aria-hidden="true" style={{ opacity: 0.5, transform: "rotate(90deg)" }}><path d="m9 18 6-6-6-6" /></svg>
                <Ico name="folder" size="i14" />Product Launch
              </div>
              <div className="aw-tree" style={{ paddingLeft: 22 }}><Ico name="fileText" size="i14" />Spec</div>
              <div className="aw-tree on" style={{ paddingLeft: 22 }}><Ico name="fileText" size="i14" />Launch Plan</div>
              <div className="aw-tree" style={{ paddingLeft: 22 }}><Ico name="task" size="i14" />Launch Tasks</div>
              <div className="aw-tree" style={{ paddingLeft: 22 }}><Ico name="sheet" size="i14" />Budget</div>
              <div className="aw-tree" style={{ paddingLeft: 22 }}><Ico name="channel" size="i14" />product-launch<span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--primary)", marginLeft: 2 }} /></div>
              <div className="aw-tree" style={{ paddingLeft: 22 }}><Ico name="bot" size="i14" />Launch AI</div>
              <div className="aw-tree">
                <svg className="i i13" viewBox="0 0 24 24" aria-hidden="true" style={{ opacity: 0.5 }}><path d="m9 18 6-6-6-6" /></svg>
                <Ico name="folder" size="i14" />Engineering
              </div>
            </div>

            <div className="aw-main">
              <div className="aw-head">
                <div className="aw-crumb">Product Launch<Ico name="chevR" size="i13" /><span style={{ color: "var(--foreground)" }}>Launch Plan</span></div>
                <div className="aw-title"><div className="h3">Launch Plan</div><span className="aw-saved"><span className="g" />Saved</span></div>
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
                <div className="h1">Launch Plan</div>
                <p>Everything for next week&rsquo;s launch — owners, timeline, and the checklist the team runs from. The AI drafted this from the spec and keeps it in sync.</p>
                <div className="h2">Launch week</div>
                <ul>
                  <li>Finalize positioning and the announcement copy</li>
                  <li>Ship the redesigned onboarding and instrument activation</li>
                  <li>Publish the launch post, send the email, and brief support</li>
                </ul>
                <blockquote>A launch is a promise you keep on a deadline.</blockquote>
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
                <div className="aw-tool"><Ico name="chevR" size="i13" style={{ color: "var(--muted-foreground)" }} /><span className="nm">read_page</span><span className="ds">Spec</span><svg className="i i13 ok" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></div>
                <div className="aw-tool"><Ico name="chevR" size="i13" style={{ color: "var(--muted-foreground)" }} /><span className="nm">create_task</span><span className="ds">Launch Tasks · 6</span><svg className="i i13 ok" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></div>
                <div className="aw-tool"><Ico name="chevR" size="i13" style={{ color: "var(--muted-foreground)" }} /><span className="nm">replace_lines</span><span className="ds">Launch Plan</span><svg className="i i13 ok" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></div>
                <div className="aw-tool"><Ico name="chevR" size="i13" style={{ color: "var(--muted-foreground)" }} /><span className="nm">gh_issue</span><span className="ds">#214</span><svg className="i i13 ok" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></div>
                <div className="aw-tool"><Ico name="chevR" size="i13" style={{ color: "var(--muted-foreground)" }} /><span className="nm">edit_sheet</span><span className="ds">Budget · B5</span><svg className="i i13 ok" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></div>
                <div className="aw-done">Done — read the spec, built the task list, wrote this plan, filed the issue, and balanced the budget.</div>
              </div>
              <div className="aw-composer">
                <div className="r">Ask about this page…</div>
                <div className="f"><span className="model">Claude / Opus 4.6</span><span className="aw-send"><Ico name="send" size="i13" /></span></div>
              </div>
            </div>
          </div>
        </div>
        </ScaledAppWindow>
      </div>
    </section>
  );
}
