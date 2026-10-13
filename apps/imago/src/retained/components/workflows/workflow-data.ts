import useSWR from 'swr';
import { fetchJSON } from '@/retained/lib/auth/auth-fetch';
import type { Workflow } from './types';

const fetcher = <T,>(url: string) => fetchJSON<T>(url);

/** An AI_CHAT page the workflow form can pick as its agent. */
export interface WorkflowAgent {
  readonly id: string;
  readonly title: string;
}

/** A drive member as the members route serves it; the owner is listed too. */
export interface DriveMemberProfile {
  readonly userId: string;
  readonly user: { readonly name: string | null } | null;
  readonly profile: { readonly displayName: string | null } | null;
}

interface PageMeta {
  readonly id: string;
  readonly title: string;
}

/**
 * The drive's workflows, as GET /api/workflows serves them: the cron rows only, each with its
 * latest run. The pane and the detail share this key, so one fetch serves both.
 */
export function useWorkflowList(driveId: string) {
  return useSWR<Workflow[]>(driveId ? `/api/workflows?driveId=${driveId}` : null, fetcher);
}

export function useDriveAgents(driveId: string) {
  return useSWR<WorkflowAgent[]>(driveId ? `/api/workflows/agents?driveId=${driveId}` : null, fetcher);
}

/** The drive's members, for the "Created by" name. */
export function useDriveMembers(driveId: string) {
  return useSWR<{ members: DriveMemberProfile[] }>(driveId ? `/api/drives/${driveId}/members` : null, fetcher);
}

/** A page's title, for the instructions and context chips. */
export function usePageMeta(pageId: string) {
  return useSWR<PageMeta>(`/api/pages/${pageId}`, fetcher);
}

/** The display name of a member, or null when the member is not in the list. */
export const memberName = (members: readonly DriveMemberProfile[], userId: string): string | null => {
  const member = members.find((entry) => entry.userId === userId);
  if (!member) return null;
  return member.profile?.displayName ?? member.user?.name ?? null;
};
