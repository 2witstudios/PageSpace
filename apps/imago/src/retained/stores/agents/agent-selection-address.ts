import { imagoHref } from '@/retained-adapters/navigation';

/**
 * Where an agent selection is mirrored in the address bar. A drive's Console has its own route;
 * with no drive the Console is Home's every-drive one (ADR 0007 D4, amended), so the selection
 * keeps the path it is on and changes only the query. Mapping the classic driveless path would
 * write /account/agents, which no longer renders, and Next would switch the shell to it.
 */
export const agentSelectionAddress = (classicHref: string, driveId: string | null, pathname: string): string => {
  const href = imagoHref(classicHref);
  if (driveId !== null) return `/imago${href}`;
  const query = href.indexOf('?');
  return query === -1 ? pathname : `${pathname}${href.slice(query)}`;
};
