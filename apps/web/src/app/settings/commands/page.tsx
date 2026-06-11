'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { useDriveStore } from '@/hooks/useDrive';
import { Button } from '@/components/ui/button';
import { Loader2, ArrowLeft, SlashSquare } from 'lucide-react';
import { canUseCommands } from '@/lib/commands/command-gating';
import { CommandsSettings } from '@/components/commands/CommandsSettings';

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
    } else if (!canUseCommands(user)) {
      // Launch exposure gate (spec §0): non-admins see no command settings
      router.push('/settings');
    }
  }, [authLoading, user, router]);

  if (authLoading || !user || !canUseCommands(user)) {
    return (
      <div className="container max-w-4xl mx-auto py-10 px-10 flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="container max-w-4xl mx-auto py-10 px-10 space-y-8">
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/settings')}
          className="mb-4"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Settings
        </Button>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <SlashSquare className="h-8 w-8" />
          Commands
        </h1>
        <p className="text-muted-foreground mt-2">
          Register pages as slash commands. Typing /trigger in any AI input injects the
          command&apos;s entry page into context; its child pages become resources the AI reads
          on demand.
        </p>
      </div>

      <CommandsSettings scope="personal" canManage />
    </div>
  );
}
