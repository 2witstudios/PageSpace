import type { ReactNode } from "react";
import { Ico, Avatar } from "./icons";

/**
 * The nine page-type mock views for the "Everything is a page" carousel.
 * Faithful, non-interactive reproductions of the real in-app views. NOTE (AEO):
 * every title here is intentionally NON-semantic (div, not h#) so the demo
 * chrome never enters the page heading outline.
 */

export interface PageType {
  id: string;
  label: string;
  icon: string;
  parent: string;
  title: string;
  actions: ReactNode;
  desc: string;
  Body: () => ReactNode;
}

const violetGrad = "linear-gradient(150deg,var(--violet-500),var(--violet-600))";

function TreeMock() {
  const Row = ({ name, icon, indent = 0, active = false, folder = false, chev }: { name: string; icon: string; indent?: number; active?: boolean; folder?: boolean; chev?: boolean }) => (
    <div className={`tr${active ? " on" : ""}${folder ? " folder" : ""}`} style={{ paddingLeft: 8 + indent }}>
      {chev === undefined ? (
        <span className="sp" />
      ) : (
        <svg className="i i14 chev" viewBox="0 0 24 24" aria-hidden="true" style={{ transform: `rotate(${chev ? 90 : 0}deg)` }}>
          <path d="m9 18 6-6-6-6" />
        </svg>
      )}
      <Ico name={icon} size="i14" />
      <span>{name}</span>
    </div>
  );
  return (
    <div className="tree-wrap">
      <Row name="Product Launch" icon="folder" folder chev />
      <Row name="Requirements" icon="fileText" indent={20} />
      <Row name="Launch Tasks" icon="task" indent={20} />
      <Row name="product-launch" icon="channel" indent={20} />
      <Row name="Product AI" icon="bot" indent={20} active />
      <Row name="Budget" icon="sheet" indent={20} />
      <Row name="Dashboard" icon="canvas" indent={20} />
      <Row name="config.json" icon="code" indent={20} />
      <Row name="Assets" icon="folder" indent={20} folder chev />
      <Row name="brief.pdf" icon="file" indent={40} />
      <Row name="Engineering" icon="folder" folder chev={false} />
    </div>
  );
}

function DocMock() {
  return (
    <>
      <div className="toolbar">
        {["bold", "italic", "strike"].map((k) => (
          <span className="tb" key={k}><Ico name={k} size="i14" /></span>
        ))}
        <span className="tsep" />
        <span className="tb"><Ico name="h1" size="i14" /></span>
        <span className="tb on"><Ico name="pil" size="i14" /></span>
        <span className="tb"><Ico name="list" size="i14" /></span>
        <span className="tb"><Ico name="quote" size="i14" /></span>
        <span className="tsep" />
        <span className="selchip">Sans<Ico name="chevD" size="i14" /></span>
        <span className="selchip">16px<Ico name="chevD" size="i14" /></span>
      </div>
      <div className="doc">
        <div className="h3">Q1 Planning</div>
        <p>A rich-text editor built on TipTap with markdown shortcuts and code blocks. Write naturally — the toolbar stays out of your way.</p>
        <p><span className="fg">AI edits your document directly.</span> Ask the sidebar chat to rewrite a paragraph and changes appear inline.</p>
        <li>Real-time collaboration &amp; version history</li>
      </div>
    </>
  );
}

function ChatMock() {
  return (
    <div className="stream">
      <div style={{ alignSelf: "flex-end", maxWidth: "80%", background: "var(--primary-soft)", borderRadius: 10, padding: "10px 12px", fontSize: 13.5 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--primary)", marginBottom: 3 }}>You</div>
        Draft the launch plan from the spec.
      </div>
      <div className="msg">
        <Avatar size={30} bg={violetGrad}><Ico name="bot" size="i18" /></Avatar>
        <div style={{ flex: 1 }}>
          <div className="who"><span className="n">Product AI</span><span className="agent-badge">agent</span></div>
          <div className="mbody2" style={{ marginBottom: 8 }}>On it — reading the spec, then I&rsquo;ll create the plan.</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div className="toolcard"><Ico name="checkCircle" size="ok" />read_page <span className="mono">Requirements</span></div>
            <div className="toolcard"><Ico name="checkCircle" size="ok" />create_page <span className="mono">Launch Plan</span></div>
          </div>
        </div>
      </div>
      <div className="composer">
        <div className="r"><span>Ask Product AI anything…</span><span className="send"><Ico name="send" size="i14" /></span></div>
      </div>
    </div>
  );
}

function ChannelMock() {
  return (
    <div className="stream" style={{ gap: 16 }}>
      <div className="msg">
        <Avatar size={32} bg="oklch(0.55 0.16 25)">S</Avatar>
        <div>
          <div className="who"><span className="n">Sarah</span><span className="t">10:34</span></div>
          <div className="mbody2">Finalise the launch email — <span className="mention">@Marketing-AI</span> draft from our positioning doc?</div>
        </div>
      </div>
      <div className="msg">
        <Avatar size={32} bg={violetGrad}><Ico name="bot" size="i18" /></Avatar>
        <div>
          <div className="who"><span className="n">Marketing AI</span><span className="agent-badge">agent</span><span className="t">10:34</span></div>
          <div className="mbody2">Draft ready: &ldquo;Meet your new AI-powered workspace.&rdquo; Want a punchier CTA?</div>
        </div>
      </div>
      <div className="msg">
        <Avatar size={32} bg="oklch(0.6 0.17 145)">M</Avatar>
        <div>
          <div className="who"><span className="n">Marcus</span><span className="t">10:35</span></div>
          <div className="mbody2">Love it. Make the CTA more action-oriented.</div>
        </div>
      </div>
      <div className="composer">
        <div className="r"><span>Message #product-launch…</span><span className="send"><Ico name="up" size="i14" /></span></div>
      </div>
    </div>
  );
}

function TaskMock() {
  const rows: [string, number, string, string, string, string, string, string, string, number][] = [
    ["Finalise positioning", 1, "b-done", "Done", "b-high", "High", "Sarah", "oklch(0.55 0.16 25)", "Feb 8", 0],
    ["Draft launch email", 0, "b-prog", "In Progress", "b-high", "High", "Marketing AI", "", "Today", 1],
    ["Review AI drafts", 0, "b-todo", "To Do", "b-med", "Medium", "Marcus", "oklch(0.6 0.17 145)", "Feb 14", 0],
    ["Generate graphics", 0, "b-todo", "To Do", "b-low", "Low", "Design AI", "", "Feb 15", 1],
  ];
  const asg = (name: string, color: string, ai: number) =>
    ai ? (
      <span className="aiasg"><span className="aidot"><Ico name="bot" size="i14" /></span>{name}</span>
    ) : (
      <span className="uasg"><Avatar size={20} bg={color}>{name[0]}</Avatar>{name}</span>
    );
  return (
    <>
      <div className="ttoolbar">
        <span className="ftab on">All</span>
        <span className="ftab">Active</span>
        <span className="ftab">Completed</span>
        <span className="tsearch"><Ico name="search" size="i14" />Search</span>
        <span className="tnew"><Ico name="plus" size="i14" />New Task</span>
      </div>
      <table className="tl">
        <thead>
          <tr>
            <th style={{ width: 34 }} />
            <th>Task</th>
            <th style={{ width: 104 }}>Status</th>
            <th style={{ width: 88 }}>Priority</th>
            <th style={{ width: 108 }}>Assignee</th>
            <th style={{ width: 60 }}>Due</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr className={r[1] ? "done" : ""} key={r[0]}>
              <td><span className={`chk${r[1] ? " on" : ""}`}>{r[1] ? <Ico name="check" size="i14" /> : null}</span></td>
              <td className="tname">{r[0]}</td>
              <td><span className={`badge ${r[2]}`}>{r[3]}</span></td>
              <td><span className={`badge ${r[4]}`}>{r[5]}</span></td>
              <td>{asg(r[6], r[7], r[9])}</td>
              <td className="muted" style={{ fontSize: 12 }}>{r[8]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function SheetMock() {
  const grid: string[][] = [
    ["", "A", "B", "C"],
    ["1", "Item", "Cost", "Owner"],
    ["2", "Ads", "4,200", "Sarah"],
    ["3", "Venue", "2,800", "Marcus"],
    ["4", "Swag", "1,100", "Design AI"],
    ["5", "Total", "8,100", ""],
  ];
  return (
    <>
      <div className="stoolbar">
        <span className="tb"><Ico name="undo2" size="i14" /></span>
        <span className="tb"><Ico name="redo2" size="i14" /></span>
        <span className="tsep" />
        <span className="tb"><Ico name="bold" size="i14" /></span>
        <span className="tb"><Ico name="italic" size="i14" /></span>
        <span className="tsep" />
        <span className="tb"><Ico name="dollar" size="i14" /></span>
        <span className="tb"><Ico name="percent" size="i14" /></span>
      </div>
      <div className="fbar"><span className="addr">B5</span><Ico name="fx" size="i14 muted" /><span className="finput">=SUM(B2:B4)</span></div>
      <div className="sgrid" style={{ margin: "0 16px" }}>
        {grid.map((row, ri) => (
          <div className="gr" key={ri}>
            {row.map((cell, ci) => {
              let cls = "gc";
              if (ri === 0) cls += " gh";
              else if (ci === 0) cls += " grh";
              else if (ci === 2) cls += " gnum";
              if (ri === 5 && ci === 2) cls += " gsel";
              const bold = ri === 5 && (ci === 1 || ci === 2);
              return (
                <div className={cls} key={ci} style={bold ? { fontWeight: 600 } : undefined}>{cell}</div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="stab"><span className="t on">Budget</span><span className="t">Forecast</span></div>
      <div className="sstatus">
        <span>B5 · <span className="mono">1 × 1</span></span>
        <span>Sum <span className="mono">8,100</span> · Avg <span className="mono">2,700</span> · Count <span className="mono">3</span></span>
      </div>
    </>
  );
}

function CanvasMock() {
  return (
    <>
      <div className="ctabs"><span className="ctab on">View</span><span className="ctab">Code</span><span className="ctab">Settings</span></div>
      <div className="cview">
        {/* Canvas renders a full static site — HTML & CSS published to a live URL. */}
        <div className="site">
          <div className="site-bar">
            <span className="dotrow"><i /><i /><i /></span>
            <span className="site-url">launch.pagespace.site</span>
          </div>
          <div className="site-nav">
            <span className="logo" />
            <span className="brand">Launch</span>
            <span className="links">
              <span className="nl">Features</span>
              <span className="nl">Pricing</span>
              <span className="cta">Start</span>
            </span>
          </div>
          <div className="site-hero">
            <div className="site-eyebrow">Launch 2026</div>
            <div className="site-h">Ship your next big thing</div>
            <div className="site-p">A full static site — built as HTML &amp; CSS, published straight to a live URL.</div>
            <span className="site-btn">Get early access</span>
          </div>
          <div className="site-foot">© 2026 Launch · Built with PageSpace</div>
        </div>
      </div>
    </>
  );
}

function CodeMock() {
  const L: ReactNode[] = [
    <span className="cm">// config.json — real-time collaboration</span>,
    <><span className="kw">export const</span> <span className="cnm">config</span> = {"{"}</>,
    <>  <span className="fn">deployment</span>: <span className="st">&quot;cloud&quot;</span>,</>,
    <>  <span className="fn">features</span>: {"{"}</>,
    <>    <span className="fn">agents</span>: <span className="kw">true</span>,</>,
    <>    <span className="fn">sandbox</span>: <span className="kw">true</span>,</>,
    <>  {"}"},</>,
    <>{"}"}</>,
  ];
  return (
    <>
      <div className="lang"><span className="langsel">JSON<Ico name="chevD" size="i14" /></span></div>
      <div className="code">
        {L.map((line, i) => (
          <div className="cl" key={i}><div className="cln">{i + 1}</div><div className="cc">{line}</div></div>
        ))}
      </div>
    </>
  );
}

function FileMock() {
  const widths = ["100%", "97%", "100%", "88%", "100%", "95%", "99%", "64%"];
  return (
    <>
      <div className="pdfbar"><span className="pdfbtn"><Ico name="chevL" size="i14" /></span>Page 1 of 14<span className="pdfbtn"><Ico name="chevR" size="i14" /></span></div>
      <div className="pdfarea">
        <div className="pdfpage">
          <div className="h" />
          <div className="sh" />
          {widths.map((w, i) => (
            <div className="pl" style={{ width: w, ...(i === 4 ? { marginTop: 16 } : {}) }} key={i} />
          ))}
        </div>
      </div>
    </>
  );
}

function FolderMock() {
  const rows: [string, string, string, string][] = [
    ["fileText", "Requirements", "Document", "2h"],
    ["task", "Launch Tasks", "Task List", "1h"],
    ["channel", "product-launch", "Channel", "5m"],
    ["bot", "Product AI", "AI Chat", "12m"],
    ["sheet", "Budget", "Sheet", "1d"],
    ["canvas", "Dashboard", "Canvas", "3d"],
    ["code", "config.json", "Code", "3d"],
    ["folder", "Assets", "Folder", "1w"],
    ["file", "brief.pdf", "File", "1w"],
  ];
  return (
    <table className="fv">
      <thead>
        <tr><th>Name</th><th style={{ width: 96 }}>Type</th><th style={{ width: 88 }}>Modified</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r[1]}>
            <td><span className="fname"><Ico name={r[0]} size={r[2] === "File" ? "leaf" : undefined} />{r[1]}</span></td>
            <td className="fdate">{r[2]}</td>
            <td className="fdate">{r[3]} ago</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const PAGE_TYPES: PageType[] = [
  { id: "tree", label: "The tree", icon: "tree", parent: "", title: "My Workspace", actions: <span className="iconbtn"><Ico name="updown" size="i14" /></span>, desc: "One tree holds every page type — and where you place a page is the context the AI gets.", Body: TreeMock },
  { id: "document", label: "Document", icon: "fileText", parent: "Product Launch", title: "Q1 Planning", actions: null, desc: "Rich-text pages with markdown, real-time collaboration, and version history.", Body: DocMock },
  { id: "ai-chat", label: "AI Chat", icon: "bot", parent: "Product Launch", title: "Product AI", actions: <><span className="pill">Anthropic<Ico name="chevD" size="i14" /></span><span className="muted">/</span><span className="pill">Opus 4.6<Ico name="chevD" size="i14" /></span></>, desc: "A conversation with an agent that reads, writes, and organises your workspace with real tools.", Body: ChatMock },
  { id: "channel", label: "Channel", icon: "channel", parent: "Product Launch", title: "product-launch", actions: <span className="muted" style={{ fontSize: 13 }}>12 members</span>, desc: "Real-time team messaging in the tree — @-mention an agent and it joins in.", Body: ChannelMock },
  { id: "task-list", label: "Task List", icon: "task", parent: "Product Launch", title: "Launch Tasks", actions: <span className="seg"><span className="s"><Ico name="book" size="i14" /></span><span className="s on"><Ico name="rows" size="i14" /></span><span className="s"><Ico name="kanban" size="i14" /></span></span>, desc: "Table and kanban views, custom statuses, and assignees that can include AI agents.", Body: TaskMock },
  { id: "sheet", label: "Sheet", icon: "sheet", parent: "Product Launch", title: "Budget", actions: <span className="iconbtn"><Ico name="download" size="i14" /></span>, desc: "Spreadsheets with formulas, live cell collaboration, and AI that reads and analyses data.", Body: SheetMock },
  { id: "canvas", label: "Canvas", icon: "canvas", parent: "Product Launch", title: "Launch Site", actions: <span className="pill pri">Publish</span>, desc: "Custom HTML and CSS in an isolated sandbox — build a full static site and publish it to a live URL.", Body: CanvasMock },
  { id: "code", label: "Code", icon: "code", parent: "Product Launch", title: "config.json", actions: null, desc: "A Monaco-powered editor — the VS Code engine — with syntax highlighting and live collaboration.", Body: CodeMock },
  { id: "file", label: "File", icon: "file", parent: "Assets", title: "brief.pdf", actions: <span className="pill on"><Ico name="download" size="i14" />Download</span>, desc: "Uploaded files with preview, text extraction, and search indexing. Identical uploads stored once.", Body: FileMock },
  { id: "folder", label: "Folder", icon: "folder", parent: "", title: "Product Launch", actions: <span className="seg"><span className="s on"><Ico name="rows" size="i14" /></span><span className="s"><Ico name="lgrid" size="i14" /></span></span>, desc: "Containers that organise other pages — no editor and no body of their own.", Body: FolderMock },
];

/** One carousel card: real ViewHeader (crumb + non-semantic title + actions) + body. */
export function MockCard({ type }: { type: PageType }) {
  const { Body } = type;
  return (
    <div className="mock">
      <div className="vh">
        {type.parent ? (
          <div className="crumb">My Workspace<Ico name="chevR" size="i14" />{type.parent}</div>
        ) : null}
        <div className="titlerow">
          <div className="vtitle">{type.title}</div>
          <div className="actions">{type.actions}</div>
        </div>
      </div>
      <div className="mbody"><Body /></div>
    </div>
  );
}
