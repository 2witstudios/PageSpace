import Link from "next/link";
import {
  ArrowRight,
  FileText,
  HardDrive,
  Sparkles,
  MessageSquare,
  ListChecks,
  Upload,
  Search,
  Users,
  KeyRound,
} from "lucide-react";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "How it Works",
  description: "Plain-language reference for PageSpace features — what each one does, how it works, and what it doesn't do.",
  path: "/docs/how-it-works",
  keywords: ["features", "how it works", "user guide", "reference"],
});

const features = [
  { title: "Pages", href: "/docs/how-it-works/pages", icon: FileText, description: "The universal container for everything in your workspace — write, organise, move, share, version." },
  { title: "Drives & Workspaces", href: "/docs/how-it-works/drives", icon: HardDrive, description: "How drives group pages and people, and how you move between them." },
  { title: "AI in your Workspace", href: "/docs/how-it-works/ai", icon: Sparkles, description: "Where AI lives, what it can touch, and how to keep it read-only when you want." },
  { title: "Channels", href: "/docs/how-it-works/channels", icon: MessageSquare, description: "Real-time messaging that sits inside your tree and lets you @-mention AI." },
  { title: "Task Lists", href: "/docs/how-it-works/task-lists", icon: ListChecks, description: "Kanban or table, custom statuses, and tasks you can assign to AI agents." },
  { title: "Files & Uploads", href: "/docs/how-it-works/files", icon: Upload, description: "Drag-and-drop uploads, background processing, OCR, and deduplicated storage." },
  { title: "Search", href: "/docs/how-it-works/search", icon: Search, description: "Find pages, drives, people, and text across everything you can see." },
  { title: "Sharing & Permissions", href: "/docs/how-it-works/sharing", icon: Users, description: "Who sees what — drive membership, roles, and per-page grants in plain English." },
  { title: "Accounts & Sign In", href: "/docs/how-it-works/accounts", icon: KeyRound, description: "Passkeys, magic links, devices — and why there's no password to forget." },
];

export default function HowItWorksIndexPage() {
  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight mb-4">How it Works</h1>
      <p className="text-lg text-muted-foreground mb-4">
        A plain-language reference for every feature in PageSpace. Each page describes what the feature does, what you can do with it, how it works, and — honestly — what it doesn&apos;t do.
      </p>
      <p className="text-sm text-muted-foreground mb-8">
        Looking for REST endpoints instead? See the <Link href="/docs/api" className="text-primary hover:underline">API Reference</Link>.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        {features.map((feature) => {
          const Icon = feature.icon;
          return (
            <Link
              key={feature.href}
              href={feature.href}
              className="group rounded-xl border border-border bg-card p-5 hover:border-primary/50 transition-colors"
            >
              <div className="flex items-center gap-3 mb-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="h-4 w-4" />
                </div>
                <h2 className="font-semibold group-hover:text-primary transition-colors">{feature.title}</h2>
              </div>
              <p className="text-sm text-muted-foreground">{feature.description}</p>
              <span className="inline-flex items-center gap-1 text-xs text-primary mt-3 group-hover:underline">
                Read <ArrowRight className="h-3 w-3" />
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
