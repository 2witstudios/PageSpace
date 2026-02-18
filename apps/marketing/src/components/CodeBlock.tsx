"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

interface CodeBlockProps {
  children?: React.ReactNode;
  className?: string;
  node?: unknown;
}

export function CodeBlock({ children, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [highlighted, setHighlighted] = useState<string | null>(null);

  const match = /language-(\w+)/.exec(className || "");
  const lang = match ? match[1] : "text";
  const code = typeof children === "string" ? children.trim() : String(children ?? "").trim();

  useEffect(() => {
    let cancelled = false;
    async function highlight() {
      try {
        const { codeToHtml } = await import("shiki");
        const html = await codeToHtml(code, {
          lang,
          theme: "github-dark-default",
        });
        if (!cancelled) setHighlighted(html);
      } catch {
        // If highlighting fails (e.g. unknown language), fall back to plain
      }
    }
    highlight();
    return () => { cancelled = true; };
  }, [code, lang]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="group relative">
      <button
        onClick={handleCopy}
        className="absolute right-3 top-3 z-10 rounded-md border border-white/10 bg-white/5 p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-white/10 hover:text-foreground group-hover:opacity-100"
        aria-label="Copy code"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {highlighted ? (
        <div
          className="[&_pre]:!rounded-xl [&_pre]:!border [&_pre]:!border-border/50 [&_pre]:!bg-[#0d1117] [&_pre]:!p-4 [&_pre]:!text-sm [&_pre]:overflow-x-auto [&_code]:!bg-transparent [&_code]:!p-0 [&_code]:!text-sm"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      ) : (
        <pre className="rounded-xl border border-border/50 bg-[#0d1117] p-4 text-sm overflow-x-auto">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
