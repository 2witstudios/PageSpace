'use client';

import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { post, del, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';

const DriveLinkSchema = z.object({
  id: z.string(),
  role: z.enum(['MEMBER', 'ADMIN']),
  customRoleId: z.string().nullable().optional(),
  customRoleName: z.string().nullable().optional(),
  customRoleColor: z.string().nullable().optional(),
  useCount: z.number(),
  shareUrl: z.string().nullable(),
});

const DriveListResponseSchema = z.object({
  links: z.array(DriveLinkSchema),
});

const CustomRoleSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable().optional(),
  isDefault: z.boolean(),
});

const RolesResponseSchema = z.object({
  roles: z.array(CustomRoleSchema),
});

export type DriveLink = z.infer<typeof DriveLinkSchema>;
export type CustomRole = z.infer<typeof CustomRoleSchema>;

// Unified role choice for the link selector. 'admin' grants full-access role,
// { customRoleId } grants a custom role's permissions, 'member' is the
// bare-membership fallback (no per-page grants). 'member' is the on-the-wire
// equivalent of "no role" on the email-invite page.
export type SelectedShareRole =
  | { kind: 'admin' }
  | { kind: 'custom'; customRoleId: string }
  | { kind: 'member' };

export function useDriveShareLink(driveId: string) {
  const [links, setLinks] = useState<DriveLink[]>([]);
  const [customRoles, setCustomRoles] = useState<CustomRole[]>([]);
  const [selectedRole, setSelectedRole] = useState<SelectedShareRole>({ kind: 'member' });
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLinks([]);
    setCustomRoles([]);

    async function loadAll() {
      try {
        const [linksResult, rolesResult] = await Promise.allSettled([
          fetch(`/api/drives/${driveId}/share-links`, { credentials: 'include' }),
          fetchWithAuth(`/api/drives/${driveId}/roles`),
        ]);

        if (!cancelled && linksResult.status === 'fulfilled' && linksResult.value.ok) {
          const raw = await linksResult.value.json();
          const parsed = DriveListResponseSchema.safeParse(raw);
          if (parsed.success) setLinks(parsed.data.links);
        }

        if (!cancelled && rolesResult.status === 'fulfilled' && rolesResult.value.ok) {
          const raw = await rolesResult.value.json();
          const parsed = RolesResponseSchema.safeParse(raw);
          if (parsed.success) {
            setCustomRoles(parsed.data.roles);
            const fallback = parsed.data.roles.find((r) => r.isDefault);
            if (fallback) {
              setSelectedRole({ kind: 'custom', customRoleId: fallback.id });
            }
          }
        }
      } catch {
        // silently fail — user can still generate a new link
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    loadAll();
    return () => {
      cancelled = true;
    };
  }, [driveId]);

  const payloadForSelected = useMemo(() => {
    if (selectedRole.kind === 'admin') {
      return { role: 'ADMIN' as const, customRoleId: null };
    }
    if (selectedRole.kind === 'custom') {
      return { role: 'MEMBER' as const, customRoleId: selectedRole.customRoleId };
    }
    return { role: 'MEMBER' as const, customRoleId: null };
  }, [selectedRole]);

  async function handleGenerate() {
    setIsGenerating(true);
    try {
      const data = await post<{ id: string; rawToken: string; shareUrl: string }>(
        `/api/drives/${driveId}/share-links`,
        payloadForSelected,
      );
      const customRole =
        selectedRole.kind === 'custom'
          ? customRoles.find((r) => r.id === selectedRole.customRoleId)
          : null;
      const newLink: DriveLink = {
        id: data.id,
        role: payloadForSelected.role,
        customRoleId: customRole?.id ?? null,
        customRoleName: customRole?.name ?? null,
        customRoleColor: customRole?.color ?? null,
        useCount: 0,
        shareUrl: data.shareUrl,
      };
      setLinks((prev) => [...prev, newLink]);
      const copied = await navigator.clipboard
        .writeText(data.shareUrl)
        .then(() => true)
        .catch(() => false);
      toast.success(copied ? 'Invite link created and copied to clipboard' : 'Invite link created');
    } catch {
      toast.error('Failed to create invite link');
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleCopy(link: DriveLink) {
    if (!link.shareUrl) return;
    const copied = await navigator.clipboard
      .writeText(link.shareUrl)
      .then(() => true)
      .catch(() => false);
    if (copied) toast.success('Invite link copied to clipboard');
    else toast.error('Could not copy link to clipboard');
  }

  async function handleRevoke(linkId: string) {
    setRevokingId(linkId);
    try {
      await del(`/api/drives/${driveId}/share-links/${linkId}`);
      setLinks((prev) => prev.filter((l) => l.id !== linkId));
      toast.success('Invite link revoked');
    } catch {
      toast.error('Failed to revoke invite link');
    } finally {
      setRevokingId((prev) => (prev === linkId ? null : prev));
    }
  }

  return {
    links,
    customRoles,
    selectedRole,
    setSelectedRole,
    isLoading,
    isGenerating,
    revokingId,
    handleGenerate,
    handleCopy,
    handleRevoke,
  };
}
