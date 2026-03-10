"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Calendar, CheckCircle2, XCircle, AlertCircle, RefreshCw, ExternalLink, CalendarDays } from "lucide-react";
import { fetchWithAuth } from "@/lib/auth/auth-fetch";
import { toast } from "sonner";
import { SettingsPageLayout } from "@/components/settings/SettingsPageLayout";
import { SettingsSection } from "@/components/settings/SettingsSection";

interface ConnectionStatus {
  connected: boolean;
  connection: {
    id: string;
    status: "active" | "expired" | "error" | "disconnected";
    statusMessage: string | null;
    googleEmail: string;
    selectedCalendars: string[];
    lastSyncAt: string | null;
    lastSyncError: string | null;
  } | null;
  syncedEventCount: number;
}

interface GoogleCalendar {
  id: string;
  summary: string;
  primary: boolean;
  backgroundColor: string | null;
}

const ERROR_MESSAGES: Record<string, string> = {
  access_denied: "You denied access to Google Calendar. Click Connect to try again.",
  oauth_error: "There was a problem connecting to Google. Please try again.",
  oauth_config: "Google Calendar integration is not configured correctly. Please contact support.",
  invalid_request: "Invalid request. Please try again.",
  invalid_state: "The connection request could not be verified. Please try again.",
  state_expired: "The connection request expired. Please try again.",
  missing_tokens: "Google did not return the required permissions. Please try again.",
  user_info_failed: "Could not verify your Google account. Please try again.",
  user_info_incomplete: "Google account details were incomplete. Please try again.",
  email_not_verified: "Your Google account email is not verified. Please verify your email in Google and try again.",
  unexpected: "An unexpected error occurred. Please try again.",
};

const formatLastSync = (dateStr: string | null) => {
  if (!dateStr) return "Never";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? "s" : ""} ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
};

const getStatusBadge = (status?: string) => {
  if (!status) return null;
  switch (status) {
    case "active":
      return <Badge variant="default" className="bg-green-500/10 text-green-600 border-green-500/20"><CheckCircle2 className="h-3 w-3 mr-1" />Connected</Badge>;
    case "expired":
      return <Badge variant="destructive" className="bg-yellow-500/10 text-yellow-600 border-yellow-500/20"><AlertCircle className="h-3 w-3 mr-1" />Expired</Badge>;
    case "error":
      return <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />Error</Badge>;
    default:
      return <Badge variant="secondary">Disconnected</Badge>;
  }
};

export default function GoogleCalendarSettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [availableCalendars, setAvailableCalendars] = useState<GoogleCalendar[]>([]);
  const [loadingCalendars, setLoadingCalendars] = useState(false);
  const [selectedCalendarIds, setSelectedCalendarIds] = useState<string[]>([]);

  const error = searchParams.get("error");
  const justConnected = searchParams.get("connected") === "true";
  const connection = status?.connection ?? null;
  const isActiveConnection = connection?.status === "active";

  const fetchStatus = useCallback(async () => {
    try {
      const response = await fetchWithAuth("/api/integrations/google-calendar/status");
      if (response.ok) {
        const data = await response.json();
        setStatus(data);
        if (data.connection) {
          setSelectedCalendarIds(data.connection.selectedCalendars || ["primary"]);
        }
      }
    } catch (err) {
      console.error("Failed to fetch status:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSync = useCallback(async (silent = false) => {
    setSyncing(true);
    try {
      const response = await fetchWithAuth("/api/integrations/google-calendar/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await response.json();
      if (!response.ok) {
        if (!silent) {
          const message = (data.error && !/^(API error|Error:)/i.test(data.error))
            ? data.error
            : "Sync could not be completed. Please try again later.";
          toast.error(message);
        }
        return;
      }
      if (!silent) {
        const { eventsCreated, eventsUpdated, eventsDeleted } = data;
        if (eventsCreated === 0 && eventsUpdated === 0 && eventsDeleted === 0) {
          toast.success("Calendar is up to date");
        } else {
          toast.success(`Synced: ${eventsCreated} new, ${eventsUpdated} updated, ${eventsDeleted} removed`);
        }
      }
      await fetchStatus();
    } catch (err) {
      console.error("Failed to sync:", err);
      if (!silent) toast.error("Failed to sync");
    } finally {
      setSyncing(false);
    }
  }, [fetchStatus]);

  const saveCalendarSelection = useCallback(async (newSelection: string[]) => {
    try {
      const response = await fetchWithAuth("/api/integrations/google-calendar/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedCalendars: newSelection }),
      });
      if (!response.ok) {
        const data = await response.json();
        toast.error(data.error || "Failed to update calendars");
        return;
      }
      handleSync(true);
    } catch (err) {
      console.error("Failed to save calendar selection:", err);
    }
  }, [handleSync]);

  const fetchCalendars = useCallback(async () => {
    setLoadingCalendars(true);
    try {
      const response = await fetchWithAuth("/api/integrations/google-calendar/calendars");
      if (response.ok) {
        const data = await response.json();
        const calendars: GoogleCalendar[] = data.calendars || [];
        setAvailableCalendars(calendars);
        const primaryCal = calendars.find((c) => c.primary);
        if (primaryCal) {
          setSelectedCalendarIds((prev) => {
            if (!prev.includes("primary")) return prev;
            const corrected = prev.map((id) => (id === "primary" ? primaryCal.id : id)).filter((id, i, arr) => arr.indexOf(id) === i);
            queueMicrotask(() => saveCalendarSelection(corrected));
            return corrected;
          });
        }
      }
    } catch (err) {
      console.error("Failed to fetch calendars:", err);
    } finally {
      setLoadingCalendars(false);
    }
  }, [saveCalendarSelection]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);
  useEffect(() => { if (isActiveConnection) fetchCalendars(); }, [isActiveConnection, fetchCalendars]);
  useEffect(() => {
    if (justConnected) {
      toast.success("Google Calendar connected successfully!");
      handleSync(true);
      router.replace("/settings/integrations/google-calendar");
    }
  }, [justConnected, router, handleSync]);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const response = await fetchWithAuth("/api/integrations/google-calendar/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnUrl: "/settings/integrations/google-calendar" }),
      });
      if (!response.ok) {
        const data = await response.json();
        toast.error(data.error || "Failed to initiate connection");
        return;
      }
      const { url } = await response.json();
      window.location.href = url;
    } catch (err) {
      console.error("Failed to connect:", err);
      toast.error("Failed to initiate connection");
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      const response = await fetchWithAuth("/api/integrations/google-calendar/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        const data = await response.json();
        toast.error(data.error || "Failed to disconnect");
        return;
      }
      toast.success("Google Calendar disconnected");
      setAvailableCalendars([]);
      await fetchStatus();
    } catch (err) {
      console.error("Failed to disconnect:", err);
      toast.error("Failed to disconnect");
    } finally {
      setDisconnecting(false);
    }
  };

  const toggleCalendar = (calendarId: string) => {
    const next = selectedCalendarIds.includes(calendarId)
      ? selectedCalendarIds.filter((id) => id !== calendarId)
      : [...selectedCalendarIds, calendarId];
    if (next.length === 0) {
      toast.error("At least one calendar must be selected");
      return;
    }
    setSelectedCalendarIds(next);
    saveCalendarSelection(next);
  };

  const SyncButton = () => (
    <Button variant="default" size="sm" disabled={syncing || disconnecting} onClick={() => handleSync()}>
      <RefreshCw className={`h-4 w-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
      {syncing ? "Syncing..." : "Sync Now"}
    </Button>
  );

  const ReconnectButton = () => (
    <Button variant="default" size="sm" disabled={connecting || disconnecting} onClick={handleConnect}>
      <RefreshCw className={`h-4 w-4 mr-2 ${connecting ? "animate-spin" : ""}`} />
      {connecting ? "Reconnecting..." : "Reconnect"}
    </Button>
  );

  return (
    <SettingsPageLayout
      title="Google Calendar"
      description="Two-way sync with Google Calendar"
      icon={Calendar}
    >
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{ERROR_MESSAGES[error] || "An error occurred. Please try again."}</AlertDescription>
        </Alert>
      )}

      <SettingsSection title="Connection" action={loading ? null : getStatusBadge(connection?.status)}>
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-10 w-32" />
          </div>
        ) : connection ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between py-2 border-b">
              <span className="text-sm text-muted-foreground">Account</span>
              <span className="font-medium">{connection.googleEmail}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b">
              <span className="text-sm text-muted-foreground">Last synced</span>
              <span className="text-sm">{formatLastSync(connection.lastSyncAt)}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b">
              <span className="text-sm text-muted-foreground">Events</span>
              <span className="text-sm font-medium">{status?.syncedEventCount ?? 0} synced</span>
            </div>
            {connection.lastSyncError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  {/^(API error|Error:|fetch failed|ECONNREFUSED)/i.test(connection.lastSyncError)
                    ? "Last sync could not be completed. Please try again later."
                    : `Last sync failed: ${connection.lastSyncError}`}
                </AlertDescription>
              </Alert>
            )}
            {!isActiveConnection && connection.statusMessage && (
              <Alert><AlertCircle className="h-4 w-4" /><AlertDescription>{connection.statusMessage}</AlertDescription></Alert>
            )}
            <div className="flex gap-2 pt-2">
              {isActiveConnection ? <SyncButton /> : <ReconnectButton />}
              <Button variant="outline" size="sm" disabled={disconnecting || syncing || connecting} onClick={handleDisconnect}>
                {disconnecting ? <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Disconnecting...</> : "Disconnect"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="text-sm text-muted-foreground">
              <p className="mb-3">Benefits of connecting:</p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li>Two-way sync keeps both calendars in sync</li>
                <li>AI can see your real availability</li>
                <li>Changes appear instantly</li>
                <li>Automatic attendee matching</li>
              </ul>
            </div>
            <Button onClick={handleConnect} disabled={connecting}>
              {connecting ? <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Connecting...</> : <><ExternalLink className="h-4 w-4 mr-2" />Connect Google Calendar</>}
            </Button>
          </div>
        )}
      </SettingsSection>

      {isActiveConnection && (
        <SettingsSection title="Calendars" icon={CalendarDays} description="Choose which calendars to keep in sync">
          {loadingCalendars ? (
            <div className="space-y-3">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
            </div>
          ) : availableCalendars.length === 0 ? (
            <p className="text-sm text-muted-foreground">No calendars found. Try reconnecting.</p>
          ) : (
            <div className="space-y-3">
              {availableCalendars.map((cal) => (
                <div key={cal.id} className="flex items-center space-x-3">
                  <Checkbox
                    id={`cal-${cal.id}`}
                    checked={selectedCalendarIds.includes(cal.id)}
                    onCheckedChange={() => toggleCalendar(cal.id)}
                  />
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    {cal.backgroundColor && (
                      <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: cal.backgroundColor }} />
                    )}
                    <Label htmlFor={`cal-${cal.id}`} className="text-sm font-medium cursor-pointer truncate">
                      {cal.summary}
                      {cal.primary && <span className="ml-1.5 text-xs text-muted-foreground">(primary)</span>}
                    </Label>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SettingsSection>
      )}

      <Alert className="bg-muted/50">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription className="text-sm">
          <span className="font-medium">Privacy & Data: </span>
          PageSpace syncs event details with your Google Calendar using two-way access. Your calendar data is stored encrypted, never shared with third parties, and never used for advertising. You can disconnect at any time.
        </AlertDescription>
      </Alert>
    </SettingsPageLayout>
  );
}
