import Link from "next/link";
import { ChevronDown, ArrowRight, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteNavbar } from "@/components/SiteNavbar";
import { SiteFooter } from "@/components/SiteFooter";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata.faq;

interface FAQItem {
  question: string;
  answer: React.ReactNode;
  category: string;
}

const faqs: FAQItem[] = [
  // Getting Started
  {
    question: "What is PageSpace?",
    answer:
      "PageSpace is an AI-powered workspace where you, your team, and AI work together. Write documents, manage tasks, chat in channels, and get AI help anywhere — all in one place.",
    category: "Getting Started",
  },
  {
    question: "Can I try PageSpace for free?",
    answer:
      "Yes! The Free plan includes 500 MB of storage, 50 AI interactions per day, real-time collaboration, and access to all core features. No credit card required.",
    category: "Getting Started",
  },
  {
    question: "How do I get started?",
    answer:
      "Sign up at pagespace.ai, create a workspace, and start adding pages. You can invite teammates right away or explore on your own first. The AI assistant is available from your very first page.",
    category: "Getting Started",
  },
  {
    question: "Is there a desktop app?",
    answer:
      "Yes — PageSpace has desktop apps for macOS (Apple Silicon and Intel), Windows, and Linux. You can download them from the Downloads page. The desktop apps include offline support and deeper OS integration.",
    category: "Getting Started",
  },

  // AI Features
  {
    question: "How does AI help me in PageSpace?",
    answer:
      "AI is woven into everything you do. It can help you draft and edit documents, summarize long threads, answer questions about your workspace, manage tasks, and more. You don't need to learn any special commands — just ask naturally.",
    category: "AI Features",
  },
  {
    question: "What are Page Agents?",
    answer:
      "Page Agents are specialized AI helpers that live in your workspace. You can create one with a role like 'Marketing Expert' or 'Project Manager' and it will tailor its responses to that area. They pick up context from where they sit in your file tree, so they get smarter the more you organize.",
    category: "AI Features",
  },
  {
    question: "What is the Global Assistant?",
    answer:
      "The Global Assistant is your personal AI that follows you across all your workspaces. It remembers your preferences and past conversations, so it gets more helpful over time. Think of it as your always-available coworker.",
    category: "AI Features",
  },
  {
    question: "Can I undo something AI changed?",
    answer:
      "Absolutely. Every AI edit is versioned, so you can roll back any change with one click. Feel free to experiment — you can always go back.",
    category: "AI Features",
  },

  // Pricing and Plans
  {
    question: "What plans are available?",
    answer:
      "PageSpace offers Free, Pro, and Team plans. Free is great for getting started, Pro unlocks more AI power and storage for individuals, and Team adds collaboration features for groups. Visit the Pricing page for full details.",
    category: "Pricing and Plans",
  },
  {
    question: "What happens when I run out of daily AI interactions?",
    answer:
      "You can still use PageSpace normally — documents, tasks, channels, and collaboration all keep working. AI features pause until the next day when your limit resets. Upgrading your plan or adding your own AI keys gives you more interactions.",
    category: "Pricing and Plans",
  },
  {
    question: "Can I change my plan later?",
    answer:
      "Yes. You can upgrade or downgrade at any time. Upgrades take effect immediately with prorated billing, and downgrades apply at the end of your current billing period.",
    category: "Pricing and Plans",
  },

  // Privacy and Data
  {
    question: "Is my data safe?",
    answer:
      "Yes. Your data is encrypted both in transit and at rest. We follow industry-standard security practices to keep your workspace secure.",
    category: "Privacy and Data",
  },
  {
    question: "Is my content used to train AI?",
    answer:
      "No. Your workspace content is never used to train AI models. When AI processes your content, it's handled through provider APIs with strict data policies — nothing is retained or used for training.",
    category: "Privacy and Data",
  },
  {
    question: "What happens to my data if I cancel?",
    answer:
      "After cancellation, your data is retained for 30 days so you can export or reactivate. After that, it's permanently deleted from our systems.",
    category: "Privacy and Data",
  },
  {
    question: "Can I export my data?",
    answer:
      "Yes. You can export your pages, files, and workspace data at any time from your account settings. Your data is yours.",
    category: "Privacy and Data",
  },

  // Collaboration and Teams
  {
    question: "How do I share a workspace with my team?",
    answer:
      "Create a workspace and invite teammates by email. You can set roles and permissions so everyone has the right level of access. Team members can join instantly from their invite link.",
    category: "Collaboration and Teams",
  },
  {
    question: "Can multiple people edit at the same time?",
    answer:
      "Yes — PageSpace supports real-time collaboration. Multiple people can edit the same document simultaneously, and you'll see each other's changes and cursors live.",
    category: "Collaboration and Teams",
  },
  {
    question: "How do channels work?",
    answer:
      "Channels are team conversation spaces, similar to Slack or Discord. You can create channels for different topics, projects, or teams. AI is available in channels too, so you can ask questions or get summaries right in the conversation.",
    category: "Collaboration and Teams",
  },

  // Mobile and Offline
  {
    question: "Can I use PageSpace on my phone?",
    answer: (
      <>
        The iOS app is available now through TestFlight — you can join from the{" "}
        <Link href="/downloads" className="text-primary hover:underline">
          Downloads page
        </Link>
        . Android is coming soon. In the meantime, PageSpace works great in your
        phone&apos;s web browser.
      </>
    ),
    category: "Mobile and Offline",
  },
  {
    question: "Can I work offline?",
    answer:
      "The desktop apps support offline mode. Your changes sync automatically when you reconnect. Web access requires an internet connection.",
    category: "Mobile and Offline",
  },
  {
    question: "Does PageSpace work in my web browser?",
    answer:
      "Yes. PageSpace works in all modern browsers — Chrome, Firefox, Safari, and Edge. No installation required, just sign in and start working.",
    category: "Mobile and Offline",
  },
];

const categories = [...new Set(faqs.map((faq) => faq.category))];

export default function FAQPage() {
  return (
    <div className="min-h-screen bg-background">
      <SiteNavbar />

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
