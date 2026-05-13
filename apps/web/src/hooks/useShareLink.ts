'use client';

import { useState, useEffect, useRef } from 'react';
import { post, del } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? '';

interface UseShareLinkMessages {
  created: string;
  createdAndCopied: string;
  copied: string;
  copyFailed: string;
  revoked: string;
  createFailed: string;
  revokeFailed: string;
}

interface UseShareLinkConfig<TLink extends { id: string; useCount: number }> {
  apiBase: string;
  extractLink: (item: Record<string, unknown>) => TLink;
  getGenerateBody: () => Record<string, unknown>;
  buildNewLink: (id: string) => TLink;
  messages: UseShareLinkMessages;
}

export function useShareLink<TLink extends { id: string; useCount: number }>({
  apiBase,
  extractLink,
  getGenerateBody,
  buildNewLink,
  messages,
}: UseShareLinkConfig<TLink>) {
  const [activeLink, setActiveLink] = useState<TLink | null>(null);
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);

  const extractLinkRef = useRef(extractLink);
  extractLinkRef.current = extractLink;
  const getGenerateBodyRef = useRef(getGenerateBody);
  getGenerateBodyRef.current = getGenerateBody;
  const buildNewLinkRef = useRef(buildNewLink);
  buildNewLinkRef.current = buildNewLink;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setActiveLink(null);
    setRawToken(null);
    async function loadExisting() {
      try {
        const res = await fetch(apiBase, { credentials: 'include' });
        if (!res.ok || cancelled) return;
        const data = await res.json() as { links: Array<Record<string, unknown>> };
        if (cancelled) return;
        setActiveLink(data.links.length > 0 ? extractLinkRef.current(data.links[0]) : null);
      } catch {
        // silently fail — user can still generate a new link
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    loadExisting();
    return () => { cancelled = true; };
  }, [apiBase]);

  async function handleGenerate() {
    setIsGenerating(true);
    // Snapshot before await — role/permissions changed mid-flight must not corrupt the stored link.
    const body = getGenerateBodyRef.current();
    const buildLink = buildNewLinkRef.current;
    try {
      const data = await post<{ id: string; rawToken: string; shareUrl: string }>(
        apiBase,
        body
      );
      setRawToken(data.rawToken);
      setActiveLink(buildLink(data.id));
      const copied = await navigator.clipboard.writeText(data.shareUrl).then(() => true).catch(() => false);
      toast.success(copied ? messagesRef.current.createdAndCopied : messagesRef.current.created);
    } catch {
      toast.error(messagesRef.current.createFailed);
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleCopy() {
    if (!rawToken) return;
    const shareUrl = new URL(`/s/${rawToken}`, APP_URL || window.location.origin).toString();
    const copied = await navigator.clipboard.writeText(shareUrl).then(() => true).catch(() => false);
    if (copied) toast.success(messagesRef.current.copied);
    else toast.error(messagesRef.current.copyFailed);
  }

  async function handleRevoke() {
    if (!activeLink) return;
    setIsRevoking(true);
    try {
      await del(`${apiBase}/${activeLink.id}`);
      setActiveLink(null);
      setRawToken(null);
      toast.success(messagesRef.current.revoked);
    } catch {
      toast.error(messagesRef.current.revokeFailed);
    } finally {
      setIsRevoking(false);
    }
  }

  return { activeLink, rawToken, isLoading, isGenerating, isRevoking, handleGenerate, handleCopy, handleRevoke };
}
