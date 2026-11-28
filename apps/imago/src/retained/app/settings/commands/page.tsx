'use client';

import { useEffect } from 'react';
import { useRouter } from '@/retained-adapters/navigation';
import { useAuth } from '@/retained/hooks/useAuth';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { Loader2 } from 'lucide-react';
import { CommandsSettings } from '@/retained/components/commands/CommandsSettings';
import { SettingsScreen } from '@/ui/settings/settings-screen/settings-screen';

/**
 * Your commands (C-Account-Commands): the viewer's personal slash commands, on the account route's
 * settings screen. The shell's Account pane is the way back, so the screen draws no "Back to Settings".
 */
export default function CommandsSettingsPage() {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const fetchDrives = useDriveStore((state) => state.fetchDrives);

  // Drive names back the shadow notice (W2) and the entry-page chip
  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.push('/auth/signin');
    }
  }, [authLoading, user, router]);

  if (authLoading || !user) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <SettingsScreen
      title="Your commands"
      lede="Type /trigger in any AI input to pull a page into context. Its child pages become resources the AI reads on demand."
    >
      <CommandsSettings scope="personal" canManage />
    </SettingsScreen>
  );
}
