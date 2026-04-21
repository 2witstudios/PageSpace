import Link from "next/link";
import { ArrowRight, Server, Monitor } from "lucide-react";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Integrations",
  description: "Connect external AI clients and tools to your PageSpace workspace.",
  path: "/docs/integrations",
  keywords: ["integrations", "MCP", "Claude Desktop", "Cursor", "desktop app"],
});

const integrations = [
  { title: "MCP", href: "/docs/integrations/mcp", icon: Server, description: "Connect Claude Desktop, Cursor, or any MCP client to your workspace using a scoped token." },
  { title: "Desktop MCP", href: "/docs/integrations/mcp/desktop", icon: Monitor, description: "Run local MCP servers inside the PageSpace desktop app — your AI chats get the same external tools you use everywhere else." },
];

export default function IntegrationsIndexPage() {
  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight mb-4">Integrations</h1>
      <p className="text-lg text-muted-foreground mb-8">
        PageSpace integrates with external AI clients through the Model Context Protocol (MCP). Generate a token, point your client at PageSpace, and your AI tool can read, search, and edit your workspace.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        {integrations.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className="group rounded-xl border border-border bg-card p-5 hover:border-primary/50 transition-colors"
            >
              <div className="flex items-center gap-3 mb-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="h-4 w-4" />
                </div>
                <h2 className="font-semibold group-hover:text-primary transition-colors">{item.title}</h2>
              </div>
              <p className="text-sm text-muted-foreground">{item.description}</p>
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
