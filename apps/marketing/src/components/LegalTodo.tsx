import { TriangleAlert } from "lucide-react";

/**
 * Visually distinct callout for unresolved legal/business facts on GDPR-related pages
 * (controller address, DPO status, retention day-counts, etc.) so they can't ship to
 * production unnoticed as plain prose text.
 */
export function LegalTodo({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="note"
      className="not-prose my-3 flex items-start gap-2 rounded-lg border-2 border-dashed border-amber-500/70 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span>
        <strong className="font-semibold">TODO:</strong> {children}
      </span>
    </div>
  );
}
