import type { ReactNode } from "react";
import { Ico } from "./landing/icons";

/** Two static palette cards: Ask (plain words) and Automate (schedule/trigger). */
export function AskAutomateSection() {
  const askRows: { icon: string; req: ReactNode; sel?: boolean }[] = [
    { icon: "bot", req: "Summarize this thread and post the highlights", sel: true },
    { icon: "task", req: "Turn this brief into a task list — and assign it" },
    { icon: "sheet", req: "Clean up this spreadsheet and total it" },
    { icon: "chart", req: "Pull the latest numbers and chart them" },
    { icon: "file", req: "Write the announcement from our meeting notes" },
  ];
  const autoRows: { icon: string; req: ReactNode; sel?: boolean }[] = [
    { icon: "clock", req: (<><span className="trg">Every Monday 9am</span> — post the weekly report</>), sel: true },
    { icon: "task", req: (<><span className="trg">When a task&rsquo;s assigned to an agent</span> — it starts</>) },
    { icon: "clock", req: (<><span className="trg">Every morning</span> — brief me on overnight changes</>) },
    { icon: "at", req: (<><span className="trg">When you&rsquo;re @mentioned</span> — reply in context</>) },
    { icon: "channel", req: (<><span className="trg">When a doc lands in Contracts</span> — pull the key terms</>) },
  ];
  return (
    <section className="band" id="capabilities" style={{ borderTop: "1px solid var(--border)" }}>
      <div className="wrap">
        <div className="center">
          <h2 className="sec">Ask, or automate.</h2>
          <p className="sub">Ask for what you need and it does it — or set it to run on its own, on a schedule or a trigger.</p>
        </div>
        <div className="pal-two">
          <div className="palette">
            <div className="pal-hd"><b>Ask</b><span className="muted">plain words</span></div>
            <div className="pal-search"><Ico name="search" /><span className="q">Ask PageSpace to…</span></div>
            <div className="pal-list">
              {askRows.map((r, i) => (
                <div className={`pal-row${r.sel ? " sel" : ""}`} key={i}>
                  <Ico name={r.icon} size="pal-ic" />
                  <span className="req">{r.req}</span>
                  {r.sel ? <span className="k">↵</span> : null}
                </div>
              ))}
            </div>
            <div className="pal-foot"><span>You describe it. It does it.</span></div>
          </div>
          <div className="palette">
            <div className="pal-hd"><b>Automate</b><span className="muted">a schedule or a trigger</span></div>
            <div className="pal-search"><Ico name="zap" /><span className="q">Run automatically when…</span></div>
            <div className="pal-list">
              {autoRows.map((r, i) => (
                <div className={`pal-row${r.sel ? " sel" : ""}`} key={i}>
                  <Ico name={r.icon} size="pal-ic" />
                  <span className="req">{r.req}</span>
                  {r.sel ? <span className="k">on</span> : null}
                </div>
              ))}
            </div>
            <div className="pal-foot"><span>Set it once. It runs on its own.</span></div>
          </div>
        </div>
      </div>
    </section>
  );
}
