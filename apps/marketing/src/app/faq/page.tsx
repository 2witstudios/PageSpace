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
  // What is PageSpace?
  {
    id: "what-is-pagespace",
    question: "What is PageSpace?",
    answer:
      "PageSpace is a workspace for writing, tasks, and team communication — with AI built in as a collaborator, not a chatbot sidebar. Your documents, spreadsheets, chats, and code files all live in the same place, and AI agents can read and edit them the same way your teammates do.",
    category: "What is PageSpace?",
  },
  {
    id: "how-is-it-different",
    question: "How is it different from tools like Notion or Google Docs?",
    answer: (
      <>
        In most tools, AI is a panel that talks about your content. In PageSpace,
        AI agents are actual workspace participants — they can create pages,
        rewrite sections, file GitHub issues, schedule meetings, and ask each
        other for help. The content model is also unified: one search, one
        permission system, one tree of pages regardless of type.
      </>
    ),
    category: "What is PageSpace?",
  },
  {
    id: "solo-or-teams",
    question: "Is it just for teams, or can I use it on my own?",
    answer:
      "Both. Individuals use it as a personal AI-powered notebook and task system. Teams use it for real-time collaboration. You can start solo and add people whenever.",
    category: "What is PageSpace?",
  },

  // Pricing and plans
  {
    id: "is-there-a-free-plan",
    question: "Is there a free plan?",
    answer:
      "Yes. The Free plan includes 500 MB of storage and 50 AI calls per day. No credit card required.",
    category: "Pricing and plans",
  },
  {
    id: "what-do-paid-plans-include",
    question: "What do the paid plans include?",
    answer: (
      <>
        More AI calls and storage. Pro is $15/month, Founder is $50/month,
        Business is $100/month. All plans include real-time collaboration, AI
        agents, and the ability to bring your own API key. Full comparison on
        the {docsLink("/pricing", "Pricing page")}.
      </>
    ),
    category: "Pricing and plans",
  },
  {
    id: "hit-daily-ai-limit",
    question: "What happens when I run out of AI calls for the day?",
    answer:
      "Everything else keeps working — your documents, tasks, channels, and collaboration are unaffected. AI features pause until your limit resets the next day. Upgrade your plan for higher daily quotas.",
    category: "Pricing and plans",
  },

  // Getting started
  {
    id: "how-do-i-sign-up",
    question: "How do I sign up?",
    answer:
      "With a passkey (Touch ID, Face ID, Windows Hello), a magic link emailed to you, or Google or Apple sign-in. There are no passwords to create or remember.",
    category: "Getting started",
  },
  {
    id: "how-do-i-get-my-team-in",
    question: "How do I get my team in?",
    answer:
      "Invite teammates by email from your drive settings. They get a link, set up their account (passkey or magic link), and land directly in your workspace. Admins get access to everything in the drive; regular members only see pages you specifically share with them.",
    category: "Getting started",
  },
  {
    id: "desktop-app",
    question: "Is there a desktop app?",
    answer: (
      <>
        Yes — macOS (Apple Silicon and Intel), Windows, and Linux. There&#39;s
        also an iOS app via TestFlight, and PageSpace works in any web browser.
        Android is in progress. See the{" "}
        {docsLink("/downloads", "Downloads page")}.
      </>
    ),
    category: "Getting started",
  },

  // Working with AI
  {
    id: "what-can-ai-do",
    question: "What can the AI actually do?",
    answer:
      "It can draft and edit documents, build task lists from briefs, summarize threads, search your workspace, update spreadsheets, schedule meetings, file GitHub issues, and ask other agents for help. It makes changes — it doesn't just answer questions.",
    category: "Working with AI",
  },
  {
    id: "specialized-ai-assistant",
    question: "Can I create a specialized AI assistant for a specific project or role?",
    answer:
      "Yes. You can place an AI agent anywhere in your workspace and give it a role — a marketing agent in your campaigns folder, a code reviewer in your engineering drive. It picks up context from where it sits, so it already knows what project it's working on.",
    category: "Working with AI",
  },
  {
    id: "which-models-available",
    question: "Which AI models are available?",
    answer:
      "You can pick from models across OpenAI, Anthropic, Google, xAI, OpenRouter, and others, or run a local model via Ollama. Each agent in your workspace can use a different model.",
    category: "Working with AI",
  },
  {
    id: "ai-access-to-content",
    question: "Will the AI touch content I haven't given it access to?",
    answer:
      "No. Agents act as the user who asked them — they can only see and edit what you can see and edit.",
    category: "Working with AI",
  },
  {
    id: "content-training",
    question: "Is my content used to train AI models?",
    answer:
      "No. Your content goes to model providers through APIs under terms that prohibit training on customer data. We don't use it to train anything either.",
    category: "Working with AI",
  },

  // Collaboration and sharing
  {
    id: "real-time-editing",
    question: "Can multiple people edit the same document at the same time?",
    answer:
      "Yes — real-time editing with live cursors on documents, spreadsheets, and canvases. Messages in channels and AI chats appear instantly for everyone.",
    category: "Collaboration and sharing",
  },
  {
    id: "no-permission-inheritance",
    question: "If I share a folder with someone, do they get access to everything inside it?",
    answer:
      "No. Sharing a folder only gives access to that folder — pages inside each need their own share. Admins and owners are the exception; they get access to everything in the drive automatically.",
    category: "Collaboration and sharing",
  },
  {
    id: "how-channels-work",
    question: "How do team chat channels work?",
    answer: (
      <>
        Channels are message threads that live in your workspace just like any
        other page — searchable, shareable, permissioned the same way. You can
        @mention teammates or AI agents, attach files, and react with emoji.
      </>
    ),
    category: "Collaboration and sharing",
  },

  // Privacy and security
  {
    id: "is-my-data-private",
    question: "Is my data private?",
    answer: (
      <>
        Yes. Content is encrypted at rest and in transit. Stored credentials
        like API keys get an additional layer of encryption. More on the{" "}
        {docsLink("/security", "Security page")}.
      </>
    ),
    category: "Privacy and security",
  },
  {
    id: "content-training-privacy",
    question: "Is my content used to train AI models?",
    answer:
      "No — worth repeating since it comes up often. Your content is never used for training, by PageSpace or by the model providers we connect to.",
    category: "Privacy and security",
  },
  {
    id: "can-i-export-data",
    question: "Can I export everything?",
    answer:
      "Yes. Documents export as Markdown or .docx, spreadsheets as CSV or XLSX, code files as source, and uploaded files as their originals.",
    category: "Privacy and security",
  },
  {
    id: "cancel-account",
    question: "What happens if I cancel?",
    answer: (
      <>
        Export anything you need before cancelling. For questions about data
        deletion, {docsLink("/contact", "contact us")}.
      </>
    ),
    category: "Privacy and security",
  },

  // Integrations
  {
    id: "what-integrations",
    question: "What does PageSpace connect to?",
    answer: (
      <>
        Google Calendar (two-way sync; agents can check your availability and
        schedule meetings), GitHub (agents can browse repos, open issues, and
        review PRs), and MCP (plug PageSpace into Claude, Cursor, or any other
        AI client that supports Model Context Protocol). See the{" "}
        {docsLink("/docs/integrations", "full list")}.
      </>
    ),
    category: "Integrations",
  },
  {
    id: "connect-to-claude-cursor",
    question: "Can I connect PageSpace to Claude, Cursor, or other AI tools?",
    answer: (
      <>
        Yes — via the PageSpace MCP server. Create a token in your settings,
        point your client at the PageSpace MCP endpoint, and it can read and
        write your workspace using the same tools the built-in agents use.{" "}
        {docsLink("/docs/integrations/mcp", "Setup guide")}.
      </>
    ),
    category: "Integrations",
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
              Everything you need to know about PageSpace. Can&#39;t find what
              you&#39;re looking for?{" "}
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
              Can&#39;t find the answer you&#39;re looking for? Our support
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
