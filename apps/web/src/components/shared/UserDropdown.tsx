"use client";

import { useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuPortal,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { LogOut, MessageSquareText, Settings, LayoutDashboard, Sun, Moon, Monitor, HardDrive, CreditCard, User } from 'lucide-react';
import { useTheme } from "next-themes";
import { useBillingVisibility } from '@/hooks/useBillingVisibility';
import useSWR from 'swr';
import { Progress } from "@/components/ui/progress";
import { useEditingStore } from '@/stores/useEditingStore';
import { FeedbackDialog } from './FeedbackDialog';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

export default function UserDropdown() {
  const { isAuthenticated, user, isLoading, actions } = useAuth();
  const router = useRouter();
  const { setTheme } = useTheme();
  const { showBilling } = useBillingVisibility();
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  // Check if any editing or streaming is active (state-based)
  const isAnyActive = useEditingStore(state => state.isAnyActive());

  // Fetch storage info
  const { data: storageInfo } = useSWR(
    isAuthenticated ? '/api/storage/info' : null,
    fetcher,
    {
      refreshInterval: 300000, // 5 minutes (reduced from 30 seconds)
      revalidateOnFocus: false, // Don't revalidate on tab focus (prevents interruptions)
      isPaused: () => isAnyActive, // Pause revalidation during editing/streaming
    }
  );

  // Fetch subscription status
  const { data: subscriptionInfo } = useSWR(
    isAuthenticated ? '/api/subscriptions/status' : null,
    fetcher,
    {
      refreshInterval: 300000, // 5 minutes (reduced from 60 seconds)
      revalidateOnFocus: false, // Don't revalidate on tab focus (prevents interruptions)
      isPaused: () => isAnyActive, // Pause revalidation during editing/streaming
    }
  );

  const handleSignOut = async () => {
    try {
      await actions.logout();
    } catch (error) {
      console.error('Logout failed:', error);
      // Still redirect to signin even if logout fails
      router.push('/auth/signin');
    }
  };

  if (isLoading) {
    return <div className="w-8 h-8 bg-gray-200 rounded-full animate-pulse" />;
  }

  if (isAuthenticated && user) {
    return (
      <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="relative h-8 w-8 rounded-full">
            <Avatar className="h-8 w-8">
              <AvatarImage src={user.image || ''} alt={user.name || 'User'} />
              <AvatarFallback>{user.name?.charAt(0).toUpperCase()}</AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56" align="end" forceMount>
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col space-y-1">
              <p className="text-sm font-medium leading-none">{user.name}</p>
              <p className="text-xs leading-none text-muted-foreground">
                {user.email}
              </p>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => router.push('/settings/account')}>
            <LayoutDashboard className="mr-2 h-4 w-4" />
            <span>Account</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push('/settings/personalization')}>
            <User className="mr-2 h-4 w-4" />
            <span>Personalization</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push('/dashboard/storage')}>
            <HardDrive className="mr-2 h-4 w-4" />
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <span>Storage</span>
                {storageInfo?.quota && (
                  <span className="text-xs text-muted-foreground ml-2">
                    {storageInfo.quota.formattedUsed} / {storageInfo.quota.formattedQuota}
                  </span>
                )}
              </div>
              {storageInfo?.quota && (
                <Progress
                  value={storageInfo.quota.utilizationPercent}
                  className="h-1 mt-1"
                />
              )}
            </div>
          </DropdownMenuItem>
          {showBilling && (
            <DropdownMenuItem onClick={() => router.push('/settings/billing')}>
              <CreditCard className="mr-2 h-4 w-4" />
              <span>
                Billing ({subscriptionInfo?.subscriptionTier === 'free' ? 'Free' : subscriptionInfo?.subscriptionTier === 'pro' ? 'Pro' : 'Business'})
              </span>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => setFeedbackOpen(true)}>
            <MessageSquareText className="mr-2 h-4 w-4" />
            <span>Feedback</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push('/settings')}>
            <Settings className="mr-2 h-4 w-4" />
            <span>Settings</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Sun className="mr-2 h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
              <Moon className="absolute mr-2 h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
              <span>Theme</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent>
                <DropdownMenuItem onClick={() => setTheme("light")}>
                  <Sun className="mr-2 h-4 w-4" />
                  <span>Light</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("dark")}>
                  <Moon className="mr-2 h-4 w-4" />
                  <span>Dark</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("system")}>
                  <Monitor className="mr-2 h-4 w-4" />
                  <span>System</span>
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleSignOut}>
            <LogOut className="mr-2 h-4 w-4" />
            <span>Log out</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <FeedbackDialog isOpen={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </>
    );
  }

  return (
    <div className="flex items-center space-x-2">
      <Button asChild variant="ghost">
        <Link href="/auth/signin">Login</Link>
      </Button>
      <Button asChild>
        <Link href="/auth/signup">Sign Up</Link>
      </Button>
    </div>
  );
}