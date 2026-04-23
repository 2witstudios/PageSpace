import {
  ChevronDown,
  FileText,
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Pilcrow,
  List,
  ListOrdered,
  Quote,
  Table2,
  Wand2,
  PenTool,
  Undo2,
  Edit3,
} from "lucide-react";

export function DocumentsSection() {
  return (
    <section className="border-t border-border bg-muted/30 py-16 md:py-24 lg:py-32 overflow-hidden">
      <div className="container mx-auto px-4 md:px-6">
        <div className="mx-auto max-w-3xl text-center mb-12 md:mb-16">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl mb-4">
            Write with AI, your way
          </h2>
          <p className="text-lg text-muted-foreground">
            Rich text editing with a full formatting toolbar.
            AI edits your documents through the sidebar chat.
          </p>
        </div>

        <div className="grid lg:grid-cols-2 gap-6 md:gap-12 items-center">
          <div className="relative order-2 lg:order-1 min-w-0">
            <EditorMock />
          </div>

          <div className="space-y-4 sm:space-y-6 order-1 lg:order-2">
            {[
              { icon: Wand2, title: "AI-Powered Editing", desc: "Talk to AI in the sidebar chat and it edits your document directly. Ask for rewrites, expansions, or tone changes without leaving your page." },
              { icon: PenTool, title: "Rich Text & Markdown", desc: "Toggle between visual editing and markdown with a click. What you see is what you get, or go full keyboard-driven." },
              { icon: Undo2, title: "One-Click Rollback", desc: "Every AI edit is versioned. Don't like what AI suggested? Roll back to any previous state instantly—no cherry-picking changes." },
              { icon: Edit3, title: "Beyond Documents", desc: "Not just rich text—code blocks, spreadsheets, and custom canvases too. Same AI-powered editing across all your content." },
            ].map((card) => (
              <div key={card.title} className="rounded-xl border border-border bg-card p-4 sm:p-6">
                <div className="flex items-start gap-3 sm:gap-4">
                  <div className="flex h-9 w-9 sm:h-10 sm:w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                    <card.icon className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-semibold mb-1">{card.title}</h3>
                    <p className="text-sm text-muted-foreground">{card.desc}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function EditorMock() {
  return (
    <div className="rounded-xl border border-border bg-card shadow-lg overflow-hidden">
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-2 sm:px-4 sm:py-3">
        <div className="flex items-center gap-2 sm:gap-3">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Editor Overview</span>
        </div>
      </div>

      <div className="mx-2 sm:mx-4 mt-2 sm:mt-4 rounded-lg liquid-glass-thin border border-[var(--separator)] shadow-[var(--shadow-ambient)] overflow-hidden">
        <div className="w-full overflow-x-auto scrollbar-none">
          <div className="flex items-center gap-0.5 sm:gap-1 p-1.5 sm:p-2 min-w-max">
            {[Bold, Italic, Strikethrough, Code].map((Icon, i) => (
              <button key={i} className="p-1.5 sm:p-2 rounded-md transition-colors hover:bg-muted"><Icon size={16} /></button>
            ))}
            <div className="w-[1px] h-6 bg-border mx-0.5 sm:mx-1" />
            {[Heading1, Heading2, Heading3].map((Icon, i) => (
              <button key={i} className={`p-1.5 sm:p-2 rounded-md transition-colors ${i === 2 ? "hidden sm:inline-flex" : ""} hover:bg-muted`}><Icon size={16} /></button>
            ))}
            <button className="p-1.5 sm:p-2 rounded-md transition-colors bg-primary text-primary-foreground"><Pilcrow size={16} /></button>
            <div className="w-[1px] h-6 bg-border mx-0.5 sm:mx-1" />
            {[List, ListOrdered, Quote].map((Icon, i) => (
              <button key={i} className={`p-1.5 sm:p-2 rounded-md transition-colors ${i === 2 ? "hidden sm:inline-flex" : ""} hover:bg-muted`}><Icon size={16} /></button>
            ))}
            <div className="hidden sm:block w-[1px] h-6 bg-border mx-1" />
            <button className="hidden sm:inline-flex p-2 rounded-md transition-colors hover:bg-muted"><Table2 size={16} /></button>
            <div className="ml-auto" />
            <div className="hidden md:block w-[1px] h-6 bg-border mx-1" />
            <button className="hidden md:inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:bg-muted transition-colors">
              Sans <ChevronDown size={10} />
            </button>
            <button className="hidden md:inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:bg-muted transition-colors">
              16px <ChevronDown size={10} />
            </button>
          </div>
        </div>
      </div>

      <div className="p-4 sm:p-6 min-h-[240px] sm:min-h-[320px]">
        <h1 className="text-lg sm:text-xl font-bold mb-3 sm:mb-4">Editor Overview</h1>
        <p className="text-sm sm:text-base text-muted-foreground mb-3 sm:mb-4">
          A rich text editor built on TipTap with full formatting, markdown shortcuts, and code blocks.
          Write naturally—the toolbar and keyboard shortcuts stay out of your way.
        </p>
        <p className="text-sm sm:text-base text-muted-foreground mb-3 sm:mb-4">
          <span className="text-foreground">AI edits your document directly.</span> Ask the sidebar chat to rewrite a paragraph, expand an outline,
          or change the tone—changes appear inline so you stay in flow.
        </p>
        <p className="text-sm sm:text-base text-muted-foreground">
          Supports headings, lists, tables, blockquotes, and fenced code blocks.
          Switch between rich text and raw markdown anytime.
        </p>
      </div>
    </div>
  );
}
