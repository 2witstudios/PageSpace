"use client";

import { useState } from "react";
import { FileCode2, FileText, FolderTree } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Agent } from "@/lib/mock/types";

interface MockFile {
  path: string;
  language: string;
  body: string;
}

/** A believable little checkout, shared by every agent in the mock. */
const FILES: MockFile[] = [
  {
    path: "package.json",
    language: "json",
    body: `{
  "name": "pagespace",
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "turbo dev",
    "test": "./scripts/test-with-db.sh"
  }
}`,
  },
  {
    path: "apps/web/src/app/api/webhooks/fanout.ts",
    language: "ts",
    body: `import { after } from 'next/server';
import { executeWorkflow } from '@pagespace/lib/services/workflows';
import { dispatchMapFor } from './dispatch-map';

/** Fan a verified webhook event out to every trigger row, off-response. */
export function fanOut(event: VerifiedWebhookEvent, triggers: TriggerRow[]) {
  after(async () => {
    for (const trigger of triggers) {
      const handler = dispatchMapFor(trigger.pageType);
      if (!handler) continue;
      await executeWorkflow(handler.workflowOf(trigger, event));
    }
  });
}`,
  },
  {
    path: "packages/lib/src/security/webhook-signature.ts",
    language: "ts",
    body: `/** Scheme-pluggable webhook signing: sign + verify share one clock. */
export const v0Scheme = {
  sign(payload: string, timestamp: string, secret: string): string {
    return hmacSha256(\`\${timestamp}.\${payload}\`, secret);
  },
  verify(payload: string, rawTimestampHeader: string, sig: string, secret: string) {
    // Verify over the RAW header — reformatting it would break the MAC.
    return timingSafeEqual(this.sign(payload, rawTimestampHeader, secret), sig);
  },
};`,
  },
  {
    path: "CLAUDE.md",
    language: "md",
    body: `# PageSpace

AI-native knowledge management platform. bun workspace + Turbo monorepo.

- bun only. Never npm/pnpm.
- Next.js 15 async params: always await context.params.
- No \`any\` types. TypeScript strict mode.`,
  },
];

/** Read-only checkout browser mock: file list beside a mono viewer. */
export default function FilesPanel({ agent }: { agent: Agent }) {
  const [selected, setSelected] = useState<MockFile>(FILES[1]);

  if (!agent.checkout) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <FolderTree className="size-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Root agents have no checkout of their own.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="w-64 shrink-0 border-r border-[var(--separator)]">
        <div className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
          {agent.checkout.repo} @ {agent.checkout.branch}
        </div>
        <ScrollArea className="h-full">
          <div className="space-y-0.5 px-2 pb-4">
            {FILES.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => setSelected(file)}
                aria-current={selected.path === file.path ? "true" : undefined}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left",
                  selected.path === file.path ? "bg-accent" : "hover:bg-accent/50",
                )}
              >
                {file.language === "md" ? (
                  <FileText className="size-3 shrink-0 text-muted-foreground" />
                ) : (
                  <FileCode2 className="size-3 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate font-mono text-xs">{file.path.split("/").pop()}</span>
              </button>
            ))}
          </div>
        </ScrollArea>
      </div>
      <div className="min-w-0 flex-1 overflow-auto">
        <div className="border-b border-[var(--separator)] px-4 py-2 font-mono text-xs text-muted-foreground">
          {selected.path}
        </div>
        <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed">{selected.body}</pre>
      </div>
    </div>
  );
}
