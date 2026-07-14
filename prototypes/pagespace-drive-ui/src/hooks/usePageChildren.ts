import { useCallback, useState } from "react";
import type { PageSpaceClient } from "@pagespace/sdk";
import { describeError, type PageRow } from "../lib/pagespace";

// Owns the array of a single parent's direct children (parentId === null means
// the drive root). Each PageTreeNode/PageTree instance calls this once for the
// level it renders — children are fetched lazily on first expand, not
// prefetched for the whole tree.
export function usePageChildren(client: PageSpaceClient, driveId: string, parentId: string | null) {
  const [children, setChildren] = useState<PageRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.pages.list({ driveId, parentId: parentId ?? undefined, ls: true });
      setChildren(result.pages);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [client, driveId, parentId]);

  const addChild = useCallback((page: PageRow) => {
    setChildren((prev) => [...(prev ?? []), page]);
  }, []);

  const removeChild = useCallback((pageId: string) => {
    setChildren((prev) => (prev ? prev.filter((p) => p.id !== pageId) : prev));
  }, []);

  const renameChild = useCallback((pageId: string, title: string) => {
    setChildren((prev) => (prev ? prev.map((p) => (p.id === pageId ? { ...p, title } : p)) : prev));
  }, []);

  return { children, loading, error, load, addChild, removeChild, renameChild };
}
