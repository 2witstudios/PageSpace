'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useThemePreference } from '@/lib/theme/theme-provider';
import { TooltipProvider } from '@/retained/components/ui/tooltip';
import { Toaster } from '@/retained/components/ui/sonner';
import QuickCreatePalette from '@/retained/components/create/QuickCreatePalette';
import { DerivedStreamingRegistrations } from '@/retained/components/ai/shared/DerivedStreamingRegistrations';
import { StreamingBridge } from './streaming-bridge';
import { SessionDirectoryListener } from '@/retained/lib/realtime/session-directory-listener';
import { WorkspaceNodesListener } from '@/retained/lib/realtime/workspace-nodes-listener';
import { VoiceSessionProvider } from '@/retained/contexts/VoiceSessionContext';
import { ChatAttachmentsProvider } from './chat-attachments';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { useParams } from 'next/navigation';
import { useAuth } from '@/retained/hooks/useAuth';

/** Retained feature providers only: never the classic Layout or global chat. */
export function RetainedProvider({ children }: { children: ReactNode }) {
  const { user, isLoading: authLoading } = useAuth();
  const userId = user?.id;
  const params = useParams<{ driveId?: string }>();
  useEffect(() => {
    if (!userId || authLoading) return;
    // The classic layout populated this shared roster; retained permission and
    // destination controls need the same authorized source inside Imago.
    void useDriveStore.getState().fetchDrives(false, true);
  }, [userId, authLoading]);
  useEffect(() => {
    useDriveStore.getState().setCurrentDrive(params.driveId ?? null);
  }, [params.driveId]);
  const { preference } = useThemePreference();
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setSystemDark(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  const dark = preference === 'dark' || (preference === 'system' && systemDark);
  return (
    <TooltipProvider><VoiceSessionProvider><ChatAttachmentsProvider>
      {children}
      <SessionDirectoryListener />
      <WorkspaceNodesListener />
      <DerivedStreamingRegistrations />
      <StreamingBridge />
      <div id="retained-portals" className={`retained-ui${dark ? ' dark' : ''}`}>
        <QuickCreatePalette />
        <Toaster />
      </div>
    </ChatAttachmentsProvider></VoiceSessionProvider></TooltipProvider>
  );
}

export function RetainedSurface({ children, fill = true }: { children: ReactNode; fill?: boolean }) {
  const { preference } = useThemePreference();
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setSystemDark(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  const dark = preference === 'dark' || (preference === 'system' && systemDark);
  return <div className={`retained-ui${dark ? ' dark' : ''}`} style={{ height: fill ? '100%' : undefined, minHeight: 0, overflow: fill ? 'auto' : undefined }}>{children}</div>;
}
