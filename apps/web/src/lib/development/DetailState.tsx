import { Cpu } from 'lucide-react';

/**
 * What a Development surface's detail region shows when the machine itself
 * can't be — shared by the drive-scoped and global layouts, since neither the
 * states nor their wording depend on which one is asking. Rendered UNDER the
 * keep-alive host (which is `absolute inset-0 z-10` and opaque), so a state
 * here is covered the moment the machine actually mounts. Without it, every
 * one of these cases is an unexplained blank region — the route renders null
 * and the host declines to mount.
 */
export function DetailState({
  authLoading,
  isAdmin,
  isLoading,
  error,
  isKnownMachine,
}: {
  authLoading: boolean;
  isAdmin: boolean;
  isLoading: boolean;
  error: Error | undefined;
  isKnownMachine: boolean;
}) {
  // `role` isn't persisted across a reload, so on every cold load it is briefly
  // unknown. Refusing the user in that window would flash "you're not an admin"
  // at an admin refreshing the page — the same gate the sidebar applies.
  if (authLoading) return <DetailNotice title="Opening machine…" />;
  if (!isAdmin) return <DetailNotice title="Machine access requires administrator privileges" />;
  // Ahead of "not found", because a failed fetch leaves the machine list empty
  // with isLoading false — indistinguishable from "this machine doesn't
  // exist" unless the error is checked first. But only when the machine ISN'T
  // known: the list polls, and SWR keeps the last good data while setting
  // `error` on a failed revalidation, so a blip must not blank out a machine
  // we can still show.
  if (error && !isKnownMachine) {
    return (
      <DetailNotice title="Failed to load machines" description="Check your connection and try again." />
    );
  }
  if (isLoading) return <DetailNotice title="Opening machine…" />;
  if (!isKnownMachine) {
    return (
      <DetailNotice
        title="Machine not found"
        description="It may have been deleted, or you may not have access to it."
      />
    );
  }
  // The machine exists and the host is mounting it — it will paint over this.
  return <DetailNotice title="Opening machine…" />;
}

function DetailNotice({ title, description }: { title: string; description?: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
      <Cpu className="size-10 text-muted-foreground" />
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
    </div>
  );
}
