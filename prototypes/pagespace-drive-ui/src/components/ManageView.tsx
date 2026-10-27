import { useEffect, useRef, useState } from "react";
import { Check, FilePlus2, Loader2, Save, Trash2 } from "lucide-react";
import type { PageSpaceClient } from "@pagespace/sdk";
import { Button } from "./ui";
import { cn } from "../lib/cn";
import { describeError, iconForType, type PageRow } from "../lib/pagespace";

/*
 * The admin surface: manage the bot's "memory" — the drive's pages — entirely
 * through @pagespace/sdk. Only shown to owners/admins of the drive. Read via
 * pages.read, write via pages.replaceLines, add via pages.create, remove via
 * pages.trash.
 */

interface ManageViewProps {
  client: PageSpaceClient;
  driveId: string;
}

export function ManageView({ client, driveId }: ManageViewProps) {
  const [pages, setPages] = useState<PageRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [totalLines, setTotalLines] = useState(1);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const editable = useRef(false);
  // Which page `draft`/`totalLines` currently belong to. Selecting a new page
  // leaves the old draft in state until the async read lands; this guards Save
  // from writing the previous page's content to the newly-selected one.
  const loadedForId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await client.pages.list({ driveId, recursive: true, ls: true });
        if (cancelled) return;
        setPages(res.pages);
        setSelectedId((cur) => cur ?? res.pages.find((p) => p.type === "DOCUMENT")?.id ?? null);
      } catch (e) {
        if (!cancelled) setError(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, driveId, refresh]);

  const selected = pages.find((p) => p.id === selectedId) ?? null;
  editable.current = selected?.type === "DOCUMENT" || selected?.type === "CODE" || selected?.type === "CANVAS";

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    loadedForId.current = null; // draft no longer matches the selected page
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const r = (await client.pages.read({ operation: "read", pageId: selectedId })) as unknown as {
          content?: string;
          totalLines?: number;
          numberedLines?: string[];
        };
        if (cancelled) return;
        const text = r.content ?? "";
        setDraft(text);
        setTotalLines(r.totalLines ?? r.numberedLines?.length ?? Math.max(1, text.split("\n").length));
        loadedForId.current = selectedId; // draft now matches the selected page
      } catch (e) {
        if (!cancelled) setError(describeError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, selectedId]);

  const save = async () => {
    if (!selectedId) return;
    // The draft in state must belong to the page we're about to overwrite.
    if (loadedForId.current !== selectedId) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const result = await client.pages.replaceLines({
        operation: "replace",
        pageId: selectedId,
        startLine: 1,
        endLine: totalLines,
        content: draft,
      });
      setTotalLines(result.totalLines);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSaving(false);
    }
  };

  const createDoc = async () => {
    const title = window.prompt("New document title");
    if (!title?.trim()) return;
    try {
      const page = await client.pages.create({ driveId, title: title.trim(), type: "DOCUMENT", content: "" });
      setRefresh((n) => n + 1);
      setSelectedId(page.id);
    } catch (e) {
      setError(describeError(e));
    }
  };

  const trash = async (id: string) => {
    if (!window.confirm("Move this page to trash?")) return;
    try {
      await client.pages.trash({ pageId: id, trash_children: false });
      if (selectedId === id) setSelectedId(null);
      setRefresh((n) => n + 1);
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <div className="flex h-full">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-sidebar">
        <div className="flex items-center justify-between border-b border-border p-3">
          <span className="text-xs font-medium text-muted-foreground">DRIVE CONTENT</span>
          <Button variant="ghost" size="sm" onClick={createDoc} className="h-7 gap-1.5 px-2">
            <FilePlus2 className="size-3.5" /> New
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <nav className="flex flex-col gap-0.5">
            {pages.map((p) => (
              <div
                key={p.id}
                className={cn(
                  "group flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  selectedId === p.id && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
                )}
              >
                <button onClick={() => setSelectedId(p.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <span className="shrink-0 text-sm">{iconForType(p.type)}</span>
                  <span className="truncate">{p.title ?? "Untitled"}</span>
                </button>
                <button
                  onClick={() => trash(p.id)}
                  className="opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  title="Trash"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </nav>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <div className="flex items-center justify-between border-b border-border px-6 py-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <span>{iconForType(selected.type)}</span>
                <span>{selected.title ?? "Untitled"}</span>
                <span className="text-xs font-normal text-muted-foreground">{selected.type}</span>
              </div>
              {editable.current && (
                <Button size="sm" onClick={save} disabled={saving || loading} className="gap-1.5">
                  {saving ? <Loader2 className="animate-spin" /> : saved ? <Check /> : <Save />}
                  {saved ? "Saved" : "Save"}
                </Button>
              )}
            </div>
            {error && (
              <div className="mx-6 mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
            <div className="min-h-0 flex-1 p-6">
              {loading ? (
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              ) : editable.current ? (
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck={false}
                  className="h-full w-full resize-none rounded-lg border border-border bg-card p-4 font-mono text-sm leading-relaxed outline-none focus-visible:ring-ring/40 focus-visible:ring-2"
                />
              ) : (
                <div className="rounded-lg border border-border bg-muted/40 p-6 text-sm text-muted-foreground">
                  This page type ({selected.type}) isn&rsquo;t text-editable in this demo. Documents, code, and canvas
                  pages are.
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select a page to edit its content.
          </div>
        )}
      </div>
    </div>
  );
}
