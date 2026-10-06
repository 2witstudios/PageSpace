import { calendarVisibilityWidens } from '@pagespace/lib/organizations/loosening-core';

/**
 * [D-OW-33] orchestrator ruling: the visibility a Google sync writes onto an existing event. Google may report the
 * event as more visible than it is here; on an org drive whose org is lapsed (`orgDriveMayNotLoosen` answers true,
 * read only for a widening) the event keeps its current visibility. Every other case takes Google's value.
 */
export async function syncedEventVisibility<V extends string>(
  current: { driveId: string | null; visibility: V } | undefined,
  incoming: V | undefined,
  orgDriveMayNotLoosen: (driveId: string) => Promise<boolean>,
): Promise<V | undefined> {
  if (!current?.driveId || incoming === undefined) return incoming;
  if (!calendarVisibilityWidens(current.visibility, incoming)) return incoming;
  return (await orgDriveMayNotLoosen(current.driveId)) ? current.visibility : incoming;
}
