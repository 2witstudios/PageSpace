import Link from "next/link";
import { ArrowRight, Layers, HardDrive, Sparkles, Users, Search, KeyRound } from "lucide-react";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Features",
  description: "Plain-language reference for the behaviours every page in PageSpace shares — pages, drives, AI, sharing, search, and accounts.",
  path: "/docs/features",
  keywords: ["features", "pages", "drives", "AI", "sharing", "search", "accounts"],
});

const features = [
  { title: "Pages", href: "/docs/features/pages", icon: Layers, description: "The universal container — create, nest, share, version, export, trash, restore." },
  { title: "Drives & Workspaces", href: "/docs/features/drives", icon: HardDrive, description: "How drives group pages and people, and how you move between them." },
  { title: "AI in your Workspace", href: "/docs/features/ai", icon: Sparkles, description: "How AI works across every page: @mentions, agent-to-agent, permissions, and providers." },
  { title: "Sharing & Permissions", href: "/docs/features/sharing", icon: Users, description: "Who sees what — drive roles and per-page grants in plain English." },
  { title: "Search", href: "/docs/features/search", icon: Search, description: "Find pages, drives, people, and text across everything you can see." },
  { title: "Accounts & Sign In", href: "/docs/features/accounts", icon: KeyRound, description: "Passkeys, magic links, devices — and why there's no password to forget." },
];

export default function FeaturesIndexPage() {
  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight mb-4">Features</h1>
      <p className="text-lg text-muted-foreground mb-8">
        Every page type shares the same set of behaviours — sharing, search, AI, accounts. This section covers what each of those behaviours does, how it works, and what it doesn&apos;t do. (Versioning and export are per-type — see the individual <Link href="/docs/page-types" className="underline underline-offset-4">page types</Link> for which ones support them.)
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
