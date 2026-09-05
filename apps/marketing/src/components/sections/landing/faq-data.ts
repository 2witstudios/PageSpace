/**
 * Homepage FAQ. Answers the top ungapped AEO fan-out queries in question form.
 * `a` is plain text (self-contained, ~40–80 words) and feeds the FAQPage JSON-LD
 * in schema.tsx — keep it in sync with what the accordion renders. `link` adds an
 * internal link after the answer for the pricing/comparison clusters.
 */
export interface FaqItem {
  q: string;
  a: string;
  link?: { href: string; label: string };
}

export const FAQ_ITEMS: FaqItem[] = [
  {
    q: "What is PageSpace?",
    a: "PageSpace is an AI-powered workspace where documents, tasks, channels, spreadsheets, and code all live as pages in one tree. Instead of a chatbot bolted on the side, an AI coworker works inside your workspace — writing and editing docs, updating sheets, running task lists, and posting in channels. It runs on Mac, Windows, Linux, and iOS.",
  },
  {
    q: "How much does PageSpace cost?",
    a: "PageSpace has a free plan that includes monthly AI credits and storage, so you can start without a card. Paid plans — including Pro — add more credits, more storage, and advanced capabilities like the code sandbox. Current limits and prices are on the pricing page.",
    link: { href: "/pricing", label: "See pricing" },
  },
  {
    q: "How is PageSpace different from Notion or ClickUp?",
    a: "Notion and ClickUp are places to store work; PageSpace is a place where AI does the work. Every page type — docs, tasks, channels, sheets, code — shares one AI coworker that reads and edits across all of them with real tools, not just a chat panel. Where you put a page is the context the AI gets.",
    link: { href: "/pricing", label: "Compare plans" },
  },
  {
    q: "How do I use PageSpace?",
    a: "Create a drive, then add pages — a document, a task list, a channel, a spreadsheet, or an AI chat — in one tree. Ask the built-in AI to do work in plain words, or set it to run on a schedule or a trigger. Everything is shareable with your team, with permissions you control.",
    link: { href: "/docs", label: "Read the docs" },
  },
  {
    q: "Who is PageSpace for?",
    a: "Teams and individuals who want AI to actually do the work, not just answer questions — founders, product and ops teams, agencies, and developers who live across docs, tasks, chat, and code. It fits anyone tired of copy-pasting between a workspace and a separate AI tool.",
  },
  {
    q: "When is PageSpace not the right fit?",
    a: "If you want a purely offline notebook with no AI, or a single-purpose tool for one narrow job, PageSpace is more than you need. It's built for teams that want an AI coworker acting across their whole workspace — if you don't want AI touching your work, it isn't the right pick.",
  },
];
