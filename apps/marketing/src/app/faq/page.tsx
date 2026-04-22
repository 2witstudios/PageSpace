import Link from "next/link";
import { ChevronDown, ArrowRight, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteNavbar } from "@/components/SiteNavbar";
import { SiteFooter } from "@/components/SiteFooter";
import { pageMetadata } from "@/lib/metadata";
import { FAQHashOpener } from "./hash-opener";

export const metadata = pageMetadata.faq;

interface FAQItem {
  id: string;
  question: string;
  answer: React.ReactNode;
  category: string;
}

const docsLink = (href: string, label: string) => (
  <Link href={href} className="text-primary hover:underline">
    {label}
  </Link>
);

const faqs: FAQItem[] = [
  // About PageSpace
  {
    id: "what-is-pagespace",
    question: "What is PageSpace?",
    answer:
      "PageSpace is an AI-native workspace where everything is a page — documents, sheets, code, AI chats, channels, task lists, canvases, folders, and files — and those pages live in a tree that humans and AI agents read and edit together. It replaces the \"document in a folder somewhere\" model with one structured space where your work and the AI that helps with it share the same material.",
    category: "About PageSpace",
  },
  {
    id: "who-is-pagespace-for",
    question: "Who is PageSpace for?",
    answer:
      "Individuals, founders, and teams who want real AI collaboration — not a chat sidebar bolted onto a document editor. PageSpace is designed for people who want AI to pick up context from where it's sitting in their workspace and actually change things on their behalf.",
    category: "About PageSpace",
  },
  {
    id: "what-makes-pagespace-different",
    question: "What makes PageSpace different from the document tools I'm already using?",
    answer: (
      <>
        Three things. (1) Pages and AI share the same tree — an agent inside a
        project folder knows it&apos;s in that project. (2) Permissions are explicit per
        page, not inherited from parents — you can&apos;t accidentally share a
        subtree. (3) Security primitives are real and inspectable: a hash-chain
        audit log, content-aware upload safety, and code you can read. Start with{" "}
        {docsLink("/docs/core-concepts", "Core Concepts")} and{" "}
        {docsLink("/security", "Security")}.
      </>
    ),
    category: "About PageSpace",
  },
  {
    id: "is-pagespace-open-source",
    question: "Is PageSpace open source?",
    answer:
      "No. PageSpace is proprietary software. Self-hosting is available as a deployment option for teams that need to run the full stack in their own infrastructure — see the self-hosting question below for details.",
    category: "About PageSpace",
  },

  // Getting Started
  {
    id: "how-do-i-sign-up",
    question: "How do I sign up?",
    answer: (
      <>
        Passkey (Touch ID, Face ID, Windows Hello), magic link (a short-lived
        sign-in email), or Google / Apple sign-in. There are no passwords to set,
        remember, or leak. More detail in{" "}
        {docsLink("/docs/features/accounts", "Accounts & Sign In")}.
      </>
    ),
    category: "Getting Started",
  },
  {
    id: "what-should-i-do-first",
    question: "What should I do first?",
    answer:
      "Create your first drive, drop a few pages into it — a document, an AI chat, maybe a task list — and ask the AI to help with something real (draft a task list from a brief, summarize a thread, rewrite a section). PageSpace gets more useful the more you organize, because agents inherit context from where they sit in the tree.",
    category: "Getting Started",
  },
  {
    id: "do-i-need-a-credit-card",
    question: "Do I need a credit card?",
    answer:
      "No. The Free plan doesn't require a credit card.",
    category: "Getting Started",
  },
  {
    id: "where-do-i-download",
    question: "Where do I download the desktop or mobile apps?",
    answer: (
      <>
        The {docsLink("/downloads", "Downloads page")} has builds for macOS (Apple
        Silicon and Intel), Windows, Linux, and iOS (via TestFlight). Android is in
        progress.
      </>
    ),
    category: "Getting Started",
  },

  // How PageSpace is organized
  {
    id: "drive-vs-page",
    question: "What's a drive vs a page?",
    answer: (
      <>
        A drive is a top-level workspace you own — think of it as the root of a
        filesystem. A page is anything inside a drive: a document, folder, sheet,
        AI chat, channel, task list, canvas, code file, or uploaded file. Pages
        nest inside each other to form a tree. See{" "}
        {docsLink("/docs/core-concepts", "Core Concepts")} for the model.
      </>
    ),
    category: "How PageSpace is organized",
  },
  {
    id: "what-page-types",
    question: "What page types can I create?",
    answer: (
      <>
        Nine: Document, Folder, Sheet, Canvas, Code, Task List, Channel, AI Chat,
        and File (uploads). Every page type lives in the same tree and can be
        nested inside any other. Full list and capabilities in{" "}
        {docsLink("/docs/page-types", "Page Types")}.
      </>
    ),
    category: "How PageSpace is organized",
  },
  {
    id: "can-i-move-pages",
    question: "Can I move and nest pages freely?",
    answer:
      "Yes. Drag pages between parents, reorder siblings, move whole subtrees. Moving a page updates its breadcrumb path, which updates the context any AI agent underneath it inherits.",
    category: "How PageSpace is organized",
  },
  {
    id: "no-permission-inheritance",
    question: "If I share a folder with someone, do they get access to everything inside it?",
    answer: (
      <>
        No. Sharing a folder only gives access to that folder — pages inside
        it each need their own grant. For teammates who need full access to a
        drive, use the Owner or Admin role; those cover every page automatically.
        For selective access, grant per page with view, edit, share, or delete
        rights and an optional expiry. More in{" "}
        {docsLink("/docs/features/sharing", "Sharing & Permissions")}.
      </>
    ),
    category: "How PageSpace is organized",
  },

  // AI in PageSpace
  {
    id: "what-can-ai-do",
    question: "What can the AI actually do in my workspace?",
    answer: (
      <>
        Read pages, edit pages, create new pages, move and rename them, search
        across content, run sheet formulas, attach files, consult other agents,
        and call out to integrations like Google Calendar and GitHub. AI
        isn&apos;t a sidebar that explains your content — it&apos;s a collaborator
        that changes it. See {docsLink("/docs/features/ai", "AI in your Workspace")}.
      </>
    ),
    category: "AI in PageSpace",
  },
  {
    id: "what-are-ai-agents",
    question: "What are AI agents and how do I create one?",
    answer: (
      <>
        An AI agent is an AI Chat page you place somewhere in your tree. Give it a
        role (system prompt), pick a provider and model, and decide which tools it
        can use. Because it lives in the tree, it picks up context from wherever
        it sits — an agent inside a project folder knows it&apos;s in that project.{" "}
        {docsLink("/docs/page-types/ai-chat", "AI Chat")} covers the full
        configuration.
      </>
    ),
    category: "AI in PageSpace",
  },
  {
    id: "what-is-global-assistant",
    question: "What's the Global Assistant, and how is it different from an agent?",
    answer:
      "The Global Assistant is a personal AI that follows you across every drive you're a member of. Use it for cross-drive questions, quick one-off tasks, or anything that isn't scoped to a single project. An agent on a page is scoped to that spot in the tree; the Global Assistant isn't.",
    category: "AI in PageSpace",
  },
  {
    id: "which-models-providers",
    question: "Which AI models and providers can I use?",
    answer: (
      <>
        Several providers across multiple hosted models, plus bring-your-own-key
        support if you prefer to pay your provider directly. Full list and per-plan
        limits on {docsLink("/pricing", "Pricing")} and{" "}
        {docsLink("/docs/features/ai", "AI in your Workspace")}.
      </>
    ),
    category: "AI in PageSpace",
  },
  {
    id: "what-is-byok",
    question: "What does \"Bring Your Own Key\" mean?",
    answer: (
      <>
        You plug in your own API keys for providers like OpenAI, Anthropic, Google,
        or OpenRouter. Your keys are encrypted at rest with AES-256-GCM and used
        to make AI calls on your behalf — which bypasses PageSpace&apos;s daily AI
        call limits entirely. BYOK is available on every plan, including Free. See{" "}
        {docsLink("/pricing", "Pricing")} for the full comparison.
      </>
    ),
    category: "AI in PageSpace",
  },
  {
    id: "ai-access-to-content",
    question: "Does AI see content I haven't given it access to?",
    answer: (
      <>
        No. Agents act as the user who invoked them. If you can&apos;t read a
        page, an agent acting on your behalf can&apos;t read it either.{" "}
        {docsLink("/docs/features/sharing", "Sharing & Permissions")} covers how
        this resolves in practice.
      </>
    ),
    category: "AI in PageSpace",
  },
  {
    id: "content-training",
    question: "Is my content used to train AI models?",
    answer:
      "No. Your workspace content is never used to train models — ours or anyone else's. When PageSpace sends content to a model provider, it goes through that provider's API under terms that prohibit training on customer data.",
    category: "AI in PageSpace",
  },
  {
    id: "undo-ai-changes",
    question: "Can I undo something AI changed?",
    answer:
      "Yes. Pages keep version history — roll back any AI (or human) edit with a click.",
    category: "AI in PageSpace",
  },

  // Working with a team
  {
    id: "how-invite-teammates",
    question: "How do I invite teammates to a drive?",
    answer:
      "Invite by email from the drive settings. Invitees get a link that sets up their account (passkey or magic link) and drops them into the drive with the role you assigned.",
    category: "Working with a team",
  },
  {
    id: "drive-roles",
    question: "What are the drive roles?",
    answer: (
      <>
        Owner (unconditional full access, can delete the drive), Admin (full
        access to every page in the drive once the invite is accepted), and Member
        (no default page access — individual pages must be granted explicitly).{" "}
        {docsLink("/docs/features/drives", "Drives & Workspaces")} has the full
        breakdown.
      </>
    ),
    category: "Working with a team",
  },
  {
    id: "real-time-editing",
    question: "Can two people edit the same page at once?",
    answer:
      "Yes. Real-time collaboration with live cursors and presence indicators works on documents, sheets, and canvases. Channels and AI chats broadcast new messages the moment they're sent.",
    category: "Working with a team",
  },
  {
    id: "share-single-page",
    question: "How do I share a single page without sharing the whole drive?",
    answer: (
      <>
        Use per-page grants. Pick a page, choose a user (or apply a role template),
        set view / edit / share / delete flags, and optionally an expiry. The
        grant applies only to that page — see the permission-cascade question
        above. Details in {docsLink("/docs/features/sharing", "Sharing & Permissions")}.
      </>
    ),
    category: "Working with a team",
  },
  {
    id: "how-channels-work",
    question: "How do channels work?",
    answer: (
      <>
        Channels are real-time message threads that live as pages in the tree.
        Post messages, react with emoji, attach files, and @mention other users
        or AI agents. Because channels are pages, they&apos;re searchable,
        shareable, and permissioned just like documents. More in{" "}
        {docsLink("/docs/page-types/channel", "Channels")}.
      </>
    ),
    category: "Working with a team",
  },
  {
    id: "agents-in-channels",
    question: "Can agents join channels and respond when @mentioned?",
    answer:
      "Yes. Put an AI Chat in the same drive and @mention it in a channel — it reads the recent conversation as context and replies inline. Mentioning an agent runs it with your permissions, not a shared service identity.",
    category: "Working with a team",
  },

  // Security and privacy
  {
    id: "how-is-data-encrypted",
    question: "How is my data encrypted?",
    answer: (
      <>
        TLS in transit for every request; volume-level encryption at rest for page
        content and file uploads; app-layer AES-256-GCM for secrets like OAuth
        tokens and stored API keys. Full posture on{" "}
        {docsLink("/security", "Security")}.
      </>
    ),
    category: "Security and privacy",
  },
  {
    id: "where-does-content-live",
    question: "Where does my content actually live?",
    answer:
      "On PostgreSQL instances managed by PageSpace for cloud customers, or on your own infrastructure if you self-host. Content is stored queryable so AI agents can read and edit it directly — the alternative (searchable-encryption schemes) would trade significant capability for protection the volume encryption already provides.",
    category: "Security and privacy",
  },
  {
    id: "upload-malware-check",
    question: "How are uploaded files checked for malware?",
    answer: (
      <>
        Every upload runs through a content-based classifier (Magika). It inspects
        the bytes of the file, not the extension — so a Windows PE binary renamed
        to <code className="rounded bg-muted px-1 py-0.5 text-xs">.txt</code> still
        gets rejected, along with Linux ELF, macOS Mach-O, Android DEX, raw HTML,
        SVG, and JavaScript. See {docsLink("/security", "Security")} for the
        details.
      </>
    ),
    category: "Security and privacy",
  },
  {
    id: "audit-log",
    question: "What's the audit log?",
    answer: (
      <>
        Security events (authentication, permission changes, data access, admin
        actions) are written to a SHA-256 hash chain. A background job
        re-verifies the chain on a schedule, and any batch emitted to external
        SIEM tools is re-verified again before delivery. A detected break halts
        emission. Full design in{" "}
        {docsLink("/docs/security/zero-trust", "Zero-Trust Architecture")}.
      </>
    ),
    category: "Security and privacy",
  },
  {
    id: "can-i-export-data",
    question: "Can I export my data?",
    answer: (
      <>
        Yes. Documents export to Markdown and .docx, sheets to CSV and XLSX, code
        pages as source files, and uploaded files as their originals. It comes
        out the way it went in. See{" "}
        {docsLink("/docs/features/pages", "Pages")} for what ships with each page
        type.
      </>
    ),
    category: "Security and privacy",
  },
  {
    id: "cancel-account",
    question: "What happens if I cancel my account?",
    answer: (
      <>
        Export anything you want to keep before cancelling. For specific questions
        about data deletion timelines,{" "}
        {docsLink("/contact", "please get in touch")}.
      </>
    ),
    category: "Security and privacy",
  },

  // Integrations and extensibility
  {
    id: "what-integrations",
    question: "What does PageSpace integrate with today?",
    answer: (
      <>
        Google Calendar (two-way sync with agent tools for availability and
        scheduling), GitHub (per-user repo access with agent tools for issues,
        PRs, and code review), and MCP (connect PageSpace to any AI client that
        speaks the Model Context Protocol). Full list on{" "}
        {docsLink("/docs/integrations", "Integrations")}.
      </>
    ),
    category: "Integrations and extensibility",
  },
  {
    id: "connect-to-claude-cursor",
    question: "Can I connect PageSpace to Claude, Cursor, or other AI clients?",
    answer: (
      <>
        Yes — PageSpace ships an MCP server. Issue a scoped token, point your
        client at the PageSpace MCP endpoint, and it can read and edit your
        workspace using the same tools our agents use. Setup in{" "}
        {docsLink("/docs/integrations/mcp", "MCP Integration")}.
      </>
    ),
    category: "Integrations and extensibility",
  },
  {
    id: "use-local-tools",
    question: "Can PageSpace use my local tools?",
    answer: (
      <>
        Yes, in PageSpace Desktop. Configure local MCP servers in Settings and
        the desktop app spawns them as subprocesses — filesystem access,
        documentation lookup (Context7), or any MCP-compatible server. Desktop
        only; not exposed to the web app. See{" "}
        {docsLink("/docs/integrations/mcp/desktop", "Desktop MCP Servers")}.
      </>
    ),
    category: "Integrations and extensibility",
  },
  {
    id: "own-oauth-credentials",
    question: "Can I use my own OAuth credentials?",
    answer:
      "No. PageSpace ships with built-in Google and Apple sign-in, plus the integrations listed above. We don't support bring-your-own OAuth providers today.",
    category: "Integrations and extensibility",
  },

  // Plans, platforms, and self-hosting
  {
    id: "what-plans",
    question: "What plans are available?",
    answer: (
      <>
        Free, Pro, Founder, and Business, plus an Enterprise track with SSO,
        custom limits, and an SLA. The full comparison is on{" "}
        {docsLink("/pricing", "Pricing")}.
      </>
    ),
    category: "Plans, platforms, and self-hosting",
  },
  {
    id: "hit-daily-ai-limit",
    question: "What happens when I hit my daily AI limit?",
    answer:
      "AI features pause until the next day when your limit resets. The rest of PageSpace — documents, sheets, channels, collaboration — keeps working. Upgrading your plan or adding your own API keys (BYOK) gets you more, and BYOK is effectively unlimited.",
    category: "Plans, platforms, and self-hosting",
  },
  {
    id: "change-plans-later",
    question: "Can I change plans later?",
    answer:
      "Yes. Upgrades take effect immediately with prorated billing; downgrades apply at the end of the current billing period.",
    category: "Plans, platforms, and self-hosting",
  },
  {
    id: "desktop-app",
    question: "Is there a desktop app?",
    answer: (
      <>
        Yes — macOS (Apple Silicon + Intel), Windows, and Linux. The desktop app
        gives you deeper OS integration (local MCP servers, native windows,
        direct file access) that the browser sandbox doesn&apos;t allow. Downloads
        on the {docsLink("/downloads", "Downloads page")}.
      </>
    ),
    category: "Plans, platforms, and self-hosting",
  },
  {
    id: "mobile-app",
    question: "Can I use PageSpace on my phone?",
    answer: (
      <>
        iOS is available now through TestFlight — join from the{" "}
        {docsLink("/downloads", "Downloads page")}. Android is in progress.
        PageSpace also runs in any modern mobile browser in the meantime.
      </>
    ),
    category: "Plans, platforms, and self-hosting",
  },
  {
    id: "self-host",
    question: "Can I self-host PageSpace?",
    answer: (
      <>
        Yes. PageSpace supports an on-prem deployment mode that runs the full
        stack in your own infrastructure — useful for teams with regulatory,
        data-residency, or network-isolation requirements. It&apos;s a
        proprietary deployment option, not an open-source release.{" "}
        {docsLink("/contact", "Contact us")} for details.
      </>
    ),
    category: "Plans, platforms, and self-hosting",
  },
];

const categories = [...new Set(faqs.map((faq) => faq.category))];

export default function FAQPage() {
  return (
    <div className="min-h-screen bg-background">
      <SiteNavbar />
      <FAQHashOpener />

      {/* Hero */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-3xl text-center">
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl mb-6">
              Frequently Asked Questions
            </h1>
            <p className="text-lg text-muted-foreground">
              Everything you need to know about PageSpace. Can&apos;t find what
              you&apos;re looking for?{" "}
              <Link href="/contact" className="text-primary hover:underline">
                Contact us
              </Link>
              .
            </p>
          </div>
        </div>
      </section>

      {/* FAQ Categories */}
      <section className="pb-16 md:pb-24">
        <div className="container mx-auto px-4 md:px-6">
          <div className="max-w-4xl mx-auto">
            {categories.map((category) => (
              <div key={category} className="mb-12">
                <h2 className="text-2xl font-bold mb-6">{category}</h2>
                <div className="space-y-4">
                  {faqs
                    .filter((faq) => faq.category === category)
                    .map((faq) => (
                      <details
                        key={faq.id}
                        id={faq.id}
                        className="group rounded-xl border border-border bg-card scroll-mt-24"
                      >
                        <summary className="flex cursor-pointer items-center justify-between p-5 font-medium">
                          <span className="pr-4">{faq.question}</span>
                          <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform group-open:rotate-180 flex-shrink-0" />
                        </summary>
                        <div className="px-5 pb-5 pt-0">
                          <div className="text-muted-foreground leading-relaxed">
                            {faq.answer}
                          </div>
                        </div>
                      </details>
                    ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Still Have Questions */}
      <section className="py-16 md:py-24 bg-muted/30">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 mb-4">
              <MessageCircle className="h-6 w-6 text-primary" />
            </div>
            <h2 className="text-2xl font-bold mb-4">Still have questions?</h2>
            <p className="text-muted-foreground mb-6">
              Can&apos;t find the answer you&apos;re looking for? Our support
              team is here to help.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button asChild>
                <Link href="/contact">
                  Contact Support
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href="/docs">Browse Documentation</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
