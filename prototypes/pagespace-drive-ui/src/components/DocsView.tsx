import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileText, Loader2, Search } from "lucide-react";
import type { PageSpaceClient } from "@pagespace/sdk";
import { Input } from "./ui";
import { cn } from "../lib/cn";
import { describeError, type PageRow } from "../lib/pagespace";

/*
 * The public docs surface, built entirely on @pagespace/sdk: it lists the
 * drive's DOCUMENT pages (pages.list), renders the selected one as a clean
 * reading page (pages.read), and searches their content (search.regex).
 */

interface DocsViewProps {
  client: PageSpaceClient;
  driveId: string;
}

interface SearchHit {
  pageId: string;
  title: string;
  lines: { lineNumber: number; content: string }[];
}

export function DocsView({ client, driveId }: DocsViewProps) {
  const [docs, setDocs] = useState<PageRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await client.pages.list({ driveId, recursive: true, ls: true });
        if (cancelled) return;
        const documents = res.pages.filter((p) => p.type === "DOCUMENT");
        setDocs(documents);
        setSelectedId((cur) => cur ?? documents[0]?.id ?? null);
      } catch (e) {
        if (!cancelled) setError(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, driveId]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setLoadingDoc(true);
    (async () => {
      try {
        const r = (await client.pages.read({ operation: "read", pageId: selectedId })) as unknown as {
          content?: string;
        };
        // We render the page title as the heading, so drop a leading `# Title`
        // line the doc body may repeat (otherwise the header shows twice).
        if (!cancelled) setContent((r.content ?? "").replace(/^\s*#\s+[^\n]*\r?\n+/, ""));
      } catch (e) {
        if (!cancelled) setError(describeError(e));
      } finally {
        if (!cancelled) setLoadingDoc(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, selectedId]);

  const runSearch = async () => {
    const pattern = query.trim();
    if (!pattern) {
      setHits(null);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const res = await client.search.regex({ driveId, pattern, searchIn: "content", maxResults: 50 });
      setHits(
        res.results.map((r) => ({
          pageId: r.pageId,
          title: r.title ?? "Untitled",
          lines: r.matchingLines.slice(0, 3),
        })),
      );
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSearching(false);
    }
  };

  const selectedTitle = useMemo(() => docs.find((d) => d.id === selectedId)?.title ?? "", [docs, selectedId]);

  return (
    <div className="flex h-full">
      {/* Docs index + search */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-sidebar">
        <div className="border-b border-border p-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              runSearch();
            }}
            className="relative"
          >
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (!e.target.value.trim()) setHits(null);
              }}
              placeholder="Search the docs…"
              className="pl-8"
            />
          </form>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {hits ? (
            <div className="flex flex-col gap-1">
              <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                {searching ? "Searching…" : `${hits.length} result${hits.length === 1 ? "" : "s"}`}
              </div>
              {hits.map((hit) => (
                <button
                  key={hit.pageId}
                  onClick={() => {
                    setSelectedId(hit.pageId);
                    setHits(null);
                    setQuery("");
                  }}
                  className="rounded-md px-2 py-2 text-left hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                >
                  <div className="text-sm font-medium">{hit.title}</div>
                  {hit.lines[0] && (
                    <div className="mt-0.5 line-clamp-1 font-mono text-xs text-muted-foreground">
                      {hit.lines[0].content.trim()}
                    </div>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <nav className="flex flex-col gap-0.5">
              {docs.map((doc) => (
                <button
                  key={doc.id}
                  onClick={() => setSelectedId(doc.id)}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    selectedId === doc.id && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
                  )}
                >
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{doc.title ?? "Untitled"}</span>
                </button>
              ))}
            </nav>
          )}
        </div>
      </aside>

      {/* Reading pane */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        <article className="mx-auto w-full max-w-3xl px-8 py-10">
          {error && (
            <div className="mb-6 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}
          {loadingDoc ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : (
            <>
              {selectedTitle && <h1 className="mb-6 text-3xl font-bold tracking-tight">{selectedTitle}</h1>}
              <div className="prose-doc">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{content || "_No content._"}</ReactMarkdown>
              </div>
            </>
          )}
        </article>
      </div>
    </div>
  );
}
