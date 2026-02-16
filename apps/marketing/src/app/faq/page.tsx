import Link from "next/link";
import { Sparkles, ChevronDown, ArrowRight, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteFooter } from "@/components/SiteFooter";
import { pageMetadata } from "@/lib/metadata";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://pagespace.ai";

export const metadata = pageMetadata.faq;

interface FAQItem {
  question: string;
  answer: string;
  category: string;
}

const faqs: FAQItem[] = [
  // Getting Started
  {
    question: "What is PageSpace?",
    answer: "PageSpace is an AI-native workspace where you, your team, and AI work together seamlessly. Unlike traditional productivity tools where AI is an afterthought, PageSpace weaves AI into every interaction—from document editing to team channels to task management.",
    category: "Getting Started",
  },
  {
    question: "How is PageSpace different from Notion or Google Docs?",
    answer: "While Notion and Google Docs are great tools, they treat AI as an add-on feature. PageSpace is built from the ground up with AI at its core. You get a Global Assistant that follows you everywhere, Page Agents with specialized knowledge that live in your file tree, and one-click rollback for any AI change.",
    category: "Getting Started",
  },
  {
    question: "Do I need to know how to use AI to benefit from PageSpace?",
    answer: "No! PageSpace is designed to be intuitive. AI suggestions appear naturally as you work—you can accept them with a click or ignore them. There's no special syntax to learn. Just work normally and let AI assist where it can.",
    category: "Getting Started",
  },

  // AI Features
  {
    question: "What is a Page Agent?",
    answer: "Page Agents are specialized AI helpers that live in your file tree. You can create them with custom prompts like 'You are a marketing expert' or 'You are a code reviewer'. They inherit context from their location in your workspace hierarchy, making them incredibly useful for domain-specific tasks.",
    category: "AI Features",
  },
  {
    question: "What's the difference between the Global Assistant and Page Agents?",
    answer: "Your Global Assistant is a personal AI that follows you across all workspaces. It knows your preferences and conversation history. Page Agents are specialized helpers tied to specific locations in your workspace—they have custom prompts and inherit context from their file tree position.",
    category: "AI Features",
  },
  {
    question: "Can I undo AI changes?",
    answer: "Yes! Every AI edit in PageSpace is versioned. You can roll back any AI change with one click, whether it's a document edit, a task completion, or a drafted message. This gives you confidence to experiment with AI suggestions without fear of losing your work.",
    category: "AI Features",
  },
  {
    question: "What AI models does PageSpace use?",
    answer: "PageSpace uses a variety of models including Claude (Anthropic), GPT-4 (OpenAI), and Gemini (Google). Different tasks use different models optimized for that use case. Pro plans include access to more powerful models like Claude Opus and GPT-4o for complex reasoning tasks.",
    category: "AI Features",
  },
  {
    question: "What is BYOK (Bring Your Own Key)?",
    answer: "BYOK allows you to use your own API keys from AI providers (OpenAI, Anthropic, Google). This gives you unlimited AI usage without counting against your plan's daily limits. It's available on all plans, including Free.",
    category: "AI Features",
  },

  // Pricing & Plans
  {
    question: "Is there a free plan?",
    answer: "Yes! Our Free plan includes 500 MB storage, 50 AI calls per day, real-time collaboration, and full access to the hierarchical AI agent system. It's perfect for individuals getting started with AI-powered productivity.",
    category: "Pricing & Plans",
  },
  {
    question: "What counts as an 'AI call'?",
    answer: "An AI call is a single interaction with our built-in AI models—like asking for a completion, requesting edits, or sending a message to an agent. Simple completions count as one call. If you use BYOK (your own API keys), those interactions don't count against your daily limit.",
    category: "Pricing & Plans",
  },
  {
    question: "What are 'Pro sessions'?",
    answer: "Pro sessions are extended AI interactions using our most powerful models (Claude Opus, GPT-4o) for complex reasoning tasks. They're designed for longer conversations, detailed analysis, and sophisticated problem-solving. Pro and higher plans include monthly Pro session allocations.",
    category: "Pricing & Plans",
  },
  {
    question: "Can I upgrade or downgrade my plan?",
    answer: "Yes, you can change your plan at any time. Upgrades take effect immediately with prorated billing. Downgrades take effect at the end of your current billing period.",
    category: "Pricing & Plans",
  },

  // Privacy & Security
  {
    question: "Is my data used to train AI models?",
    answer: "No. Your workspace content is never used to train AI models. We use AI providers' API services which have strict data handling policies—your data is processed but not retained or used for training.",
    category: "Privacy & Security",
  },
  {
    question: "Where is my data stored?",
    answer: "Your data is stored in secure, encrypted cloud infrastructure. We use industry-standard encryption at rest and in transit. Enterprise plans can request specific data residency locations.",
    category: "Privacy & Security",
  },
  {
    question: "Does PageSpace support SSO?",
    answer: "Yes, Enterprise plans support SSO with SAML and OIDC providers. Contact our sales team for setup assistance.",
    category: "Privacy & Security",
  },

  // Security
  {
    question: "How does PageSpace secure user sessions?",
    answer: "PageSpace uses opaque session tokens with hash-only storage—we never store your actual token, only a SHA-256 hash. This means even if our database were compromised, attackers couldn't use the hashes to impersonate users. Sessions can be instantly revoked, and we validate every request against our database.",
    category: "Security",
  },
  {
    question: "How does PageSpace protect against brute force attacks?",
    answer: "We use distributed rate limiting and database-backed account lockout. Login attempts are limited to 5 per 15 minutes per IP and per email. After 10 failed attempts, accounts are locked for 15 minutes. This lockout persists across IP changes because it's stored in our database, not just in memory.",
    category: "Security",
  },
  {
    question: "How does PageSpace secure real-time collaboration?",
    answer: "WebSocket connections use per-event authorization—every write operation (document updates, file uploads, task changes) is re-authorized in real-time. We use short-lived socket tokens (5-minute expiry) and HMAC-signed inter-service communication. Read-only events like cursor movement use connection-level auth for performance.",
    category: "Security",
  },
  {
    question: "What authentication methods does PageSpace support?",
    answer: "PageSpace supports email/password authentication with strong requirements (12+ characters, mixed case, numbers) and OAuth with Google and Apple. Passwords are hashed with bcrypt (cost factor 12). All authentication flows include CSRF protection with HMAC-signed tokens.",
    category: "Security",
  },
  {
    question: "How does PageSpace handle security events?",
    answer: "We log security events including login attempts, CSRF failures, and admin actions for audit trails. Rate limiting is distributed across our infrastructure, not just in-memory, ensuring protection even across restarts. We use timing-safe comparisons to prevent timing attacks on sensitive operations.",
    category: "Security",
  },

  // Integrations
  {
    question: "What is MCP?",
    answer: "MCP (Model Context Protocol) is an open protocol that allows AI to safely interact with external tools and data. PageSpace uses MCP servers to connect AI to your database, file system, GitHub, calendar, and more. Instead of copy-pasting, AI can directly access the tools you use.",
    category: "Integrations",
  },
  {
    question: "What integrations does PageSpace support?",
    answer: "PageSpace integrates with Google Calendar for two-way sync, GitHub for repository management, and supports custom webhooks and a full REST API. Through MCP servers, you can also connect to databases, Slack, file systems, and more.",
    category: "Integrations",
  },
  {
    question: "Can I build custom integrations?",
    answer: "Yes! PageSpace offers a REST API for programmatic access to workspaces, pages, and AI capabilities. You can also build custom MCP servers to connect AI to your own tools and data sources.",
    category: "Integrations",
  },

  // Desktop & Mobile
  {
    question: "Are there desktop apps?",
    answer: "Yes! PageSpace has native desktop apps for macOS (Apple Silicon and Intel), Windows, and Linux. Desktop apps include offline support and deeper OS integration.",
    category: "Apps",
  },
  {
    question: "Are there mobile apps?",
    answer: "Mobile apps for iOS and Android are currently in beta. You can request access through TestFlight (iOS) or our Android beta program from the Downloads page.",
    category: "Apps",
  },
];

const categories = [...new Set(faqs.map((faq) => faq.category))];

export default function FAQPage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Navigation */}
      <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-16 items-center justify-between px-4 md:px-6">
          <Link href="/" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
              <Sparkles className="h-5 w-5 text-primary-foreground" />
            </div>
            <span className="text-xl font-bold">PageSpace</span>
          </Link>
          <nav className="hidden md:flex items-center gap-6">
            <Link href="/pricing" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              Pricing
            </Link>
            <Link href="/downloads" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              Downloads
            </Link>
            <Link href="/docs" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              Docs
            </Link>
            <Link href="/blog" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              Blog
            </Link>
          </nav>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" asChild className="hidden sm:inline-flex">
              <a href={`${APP_URL}/auth/signin`}>Log in</a>
            </Button>
            <Button size="sm" asChild>
              <a href={`${APP_URL}/auth/signup`}>Get Started</a>
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-3xl text-center">
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl mb-6">
              Frequently Asked Questions
            </h1>
            <p className="text-lg text-muted-foreground">
              Everything you need to know about PageSpace. Can&apos;t find what you&apos;re looking for?{" "}
              <Link href="/contact" className="text-primary hover:underline">Contact us</Link>.
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
                    .map((faq, index) => (
                      <details
                        key={index}
                        className="group rounded-xl border border-border bg-card"
                      >
                        <summary className="flex cursor-pointer items-center justify-between p-5 font-medium">
                          <span className="pr-4">{faq.question}</span>
                          <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform group-open:rotate-180 flex-shrink-0" />
                        </summary>
                        <div className="px-5 pb-5 pt-0">
                          <p className="text-muted-foreground leading-relaxed">
                            {faq.answer}
                          </p>
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
              Can&apos;t find the answer you&apos;re looking for? Our support team is here to help.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button asChild>
                <Link href="/contact">
                  Contact Support
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href="/docs">
                  Browse Documentation
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter variant="compact" />
    </div>
  );
}
