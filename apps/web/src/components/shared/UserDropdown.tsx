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
import { LogOut, MessageSquareText, Settings, LayoutDashboard, Sun, Moon, Monitor, HardDrive, CreditCard, Sparkles, Check } from 'lucide-react';
import { useTheme } from "next-themes";
import { useBillingVisibility } from '@/hooks/useBillingVisibility';
import useSWR from 'swr';
import { Progress } from "@/components/ui/progress";
import { useEditingStore } from '@/stores/useEditingStore';
import { FeedbackDialog } from './FeedbackDialog';
import { useMobile } from '@/hooks/useMobile';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

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
  const { theme, setTheme } = useTheme();
  const { showBilling } = useBillingVisibility();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const isMobile = useMobile();

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
    // Mobile: bottom sheet with sections
    if (isMobile) {
      return (
        <>
          <Button variant="ghost" className="relative h-8 w-8 rounded-full" onClick={() => setSheetOpen(true)}>
            <Avatar className="h-8 w-8">
              <AvatarImage src={user.image || ''} alt={user.name || 'User'} />
              <AvatarFallback>{user.name?.charAt(0).toUpperCase()}</AvatarFallback>
            </Avatar>
          </Button>

          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetContent
              side="bottom"
              className="rounded-t-2xl max-h-[85vh] pb-[calc(1rem+env(safe-area-inset-bottom))]"
            >
              <SheetHeader className="px-5 pt-3 pb-0">
                <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted-foreground/30" />
                <SheetTitle className="sr-only">Account Menu</SheetTitle>
                <SheetDescription className="sr-only">Account options and settings</SheetDescription>
              </SheetHeader>

              <div className="overflow-y-auto px-5 pb-4">
                {/* User info */}
                <div className="flex items-center gap-3 py-3 mb-2">
                  <Avatar className="h-12 w-12">
                    <AvatarImage src={user.image || ''} alt={user.name || 'User'} />
                    <AvatarFallback className="text-lg">{user.name?.charAt(0).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium">{user.name}</p>
                    <p className="text-sm text-muted-foreground">{user.email}</p>
                  </div>
                </div>

                <div className="h-px bg-border mb-2" />

                {/* Account section */}
                <div className="space-y-0.5 mb-3">
                  <button
                    onClick={() => { setSheetOpen(false); router.push('/settings/account'); }}
                    className="flex items-center gap-3 w-full px-3 py-3 rounded-lg text-sm active:bg-accent transition-colors"
                  >
                    <LayoutDashboard className="h-5 w-5 text-muted-foreground" />
                    <span className="font-medium">Account</span>
                  </button>
                  <button
                    onClick={() => { setSheetOpen(false); router.push('/settings/personalization'); }}
                    className="flex items-center gap-3 w-full px-3 py-3 rounded-lg text-sm active:bg-accent transition-colors"
                  >
                    <Sparkles className="h-5 w-5 text-muted-foreground" />
                    <span className="font-medium">Personalization</span>
                  </button>
                  <button
                    onClick={() => { setSheetOpen(false); router.push('/dashboard/storage'); }}
                    className="flex items-center gap-3 w-full px-3 py-3 rounded-lg text-sm active:bg-accent transition-colors"
                  >
                    <HardDrive className="h-5 w-5 text-muted-foreground" />
                    <div className="flex-1 text-left">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">Storage</span>
                        {storageInfo?.quota && (
                          <span className="text-xs text-muted-foreground">
                            {storageInfo.quota.formattedUsed} / {storageInfo.quota.formattedQuota}
                          </span>
                        )}
                      </div>
                      {storageInfo?.quota && (
                        <Progress value={storageInfo.quota.utilizationPercent} className="h-1 mt-1.5" />
                      )}
                    </div>
                  </button>
                  {showBilling && (
                    <button
                      onClick={() => { setSheetOpen(false); router.push('/settings/billing'); }}
                      className="flex items-center gap-3 w-full px-3 py-3 rounded-lg text-sm active:bg-accent transition-colors"
                    >
                      <CreditCard className="h-5 w-5 text-muted-foreground" />
                      <span className="font-medium">
                        Billing ({subscriptionInfo?.subscriptionTier === 'free' ? 'Free' : subscriptionInfo?.subscriptionTier === 'pro' ? 'Pro' : 'Business'})
                      </span>
                    </button>
                  )}
                  <button
                    onClick={() => { setSheetOpen(false); setFeedbackOpen(true); }}
                    className="flex items-center gap-3 w-full px-3 py-3 rounded-lg text-sm active:bg-accent transition-colors"
                  >
                    <MessageSquareText className="h-5 w-5 text-muted-foreground" />
                    <span className="font-medium">Feedback</span>
                  </button>
                  <button
                    onClick={() => { setSheetOpen(false); router.push('/settings'); }}
                    className="flex items-center gap-3 w-full px-3 py-3 rounded-lg text-sm active:bg-accent transition-colors"
                  >
                    <Settings className="h-5 w-5 text-muted-foreground" />
                    <span className="font-medium">Settings</span>
                  </button>
                </div>

                <div className="h-px bg-border mb-2" />

                {/* Theme section - inline instead of nested submenu */}
                <div className="mb-3">
                  <p className="text-xs font-medium text-muted-foreground mb-2 px-3">Appearance</p>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      onClick={() => setTheme("light")}
                      className={cn(
                        "flex flex-col items-center gap-1.5 py-3 rounded-lg border text-sm transition-colors",
                        theme === 'light' ? 'border-primary bg-primary/5 text-primary' : 'border-border'
                      )}
                    >
                      <Sun className="h-5 w-5" />
                      <span className="text-xs font-medium">Light</span>
                      {theme === 'light' && <Check className="h-3 w-3" />}
                    </button>
                    <button
                      onClick={() => setTheme("dark")}
                      className={cn(
                        "flex flex-col items-center gap-1.5 py-3 rounded-lg border text-sm transition-colors",
                        theme === 'dark' ? 'border-primary bg-primary/5 text-primary' : 'border-border'
                      )}
                    >
                      <Moon className="h-5 w-5" />
                      <span className="text-xs font-medium">Dark</span>
                      {theme === 'dark' && <Check className="h-3 w-3" />}
                    </button>
                    <button
                      onClick={() => setTheme("system")}
                      className={cn(
                        "flex flex-col items-center gap-1.5 py-3 rounded-lg border text-sm transition-colors",
                        theme === 'system' ? 'border-primary bg-primary/5 text-primary' : 'border-border'
                      )}
                    >
                      <Monitor className="h-5 w-5" />
                      <span className="text-xs font-medium">System</span>
                      {theme === 'system' && <Check className="h-3 w-3" />}
                    </button>
                  </div>
                </div>

                <div className="h-px bg-border mb-2" />

                {/* Sign out */}
                <button
                  onClick={() => { setSheetOpen(false); handleSignOut(); }}
                  className="flex items-center gap-3 w-full px-3 py-3 rounded-lg text-sm text-destructive active:bg-destructive/10 transition-colors"
                >
                  <LogOut className="h-5 w-5" />
                  <span className="font-medium">Log out</span>
                </button>
              </div>
            </SheetContent>
          </Sheet>

          <FeedbackDialog isOpen={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
        </>
      );
    }

    // Desktop: dropdown menu
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
            <Sparkles className="mr-2 h-4 w-4" />
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
