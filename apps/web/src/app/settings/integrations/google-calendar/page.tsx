"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Calendar, CheckCircle2, XCircle, AlertCircle, RefreshCw, ExternalLink } from "lucide-react";
import { fetchWithAuth } from "@/lib/auth/auth-fetch";
import { toast } from "sonner";

interface ConnectionStatus {
  connected: boolean;
  connection: {
    id: string;
    status: "active" | "expired" | "error" | "disconnected" | "pending" | "revoked";
    statusMessage: string | null;
    googleEmail: string;
    selectedCalendars: string[];
    syncFrequencyMinutes: number;
    markAsReadOnly: boolean;
    targetDriveId: string | null;
    lastSyncAt: string | null;
    lastSyncError: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
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

export default function GoogleCalendarSettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const error = searchParams.get("error");
  const justConnected = searchParams.get("connected") === "true";
  const connection = status?.connection ?? null;
  const connectionStatus = connection?.status;
  const isActiveConnection = connectionStatus === "active";

  const fetchStatus = async () => {
    try {
      const response = await fetchWithAuth("/api/integrations/google-calendar/status");
      if (response.ok) {
        const data = await response.json();
        setStatus(data);
      }
    } catch (err) {
      console.error("Failed to fetch status:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleSync = useCallback(async (silent = false) => {
    setSyncing(true);
    try {
      const response = await fetchWithAuth("/api/integrations/google-calendar/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      const data = await response.json();

      if (!response.ok) {
        if (!silent) toast.error(data.error || "Sync failed");
        return;
      }

      if (!silent) {
        const { eventsCreated, eventsUpdated, eventsDeleted } = data;
        if (eventsCreated === 0 && eventsUpdated === 0 && eventsDeleted === 0) {
          toast.success("Calendar is up to date");
        } else {
          toast.success(
            `Synced: ${eventsCreated} new, ${eventsUpdated} updated, ${eventsDeleted} removed`
          );
        }
      }

      await fetchStatus();
    } catch (err) {
      console.error("Failed to sync:", err);
      if (!silent) toast.error("Failed to sync");
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, []);

  useEffect(() => {
    if (justConnected) {
      toast.success("Google Calendar connected successfully!");
      // Trigger initial sync
      handleSync(true);
      // Clean up URL
      router.replace("/settings/integrations/google-calendar");
    }
  }, [justConnected, router, handleSync]);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const response = await fetchWithAuth("/api/integrations/google-calendar/connect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          returnUrl: "/settings/integrations/google-calendar",
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        toast.error(data.error || "Failed to initiate connection");
        return;
      }

      const { url } = await response.json();
      // Redirect to Google OAuth
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
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const data = await response.json();
        toast.error(data.error || "Failed to disconnect");
        return;
      }

      toast.success("Google Calendar disconnected");
      await fetchStatus();
    } catch (err) {
      console.error("Failed to disconnect:", err);
      toast.error("Failed to disconnect");
    } finally {
      setDisconnecting(false);
    }
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

  const getStatusBadge = () => {
    if (!status?.connection) return null;

    switch (status.connection.status) {
      case "active":
        return (
          <Badge variant="default" className="bg-green-500/10 text-green-600 border-green-500/20">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Connected
          </Badge>
        );
      case "expired":
        return (
          <Badge variant="destructive" className="bg-yellow-500/10 text-yellow-600 border-yellow-500/20">
            <AlertCircle className="h-3 w-3 mr-1" />
            Expired
          </Badge>
        );
      case "error":
        return (
          <Badge variant="destructive">
            <XCircle className="h-3 w-3 mr-1" />
            Error
          </Badge>
        );
      case "pending":
        return (
          <Badge variant="secondary">
            <AlertCircle className="h-3 w-3 mr-1" />
            Pending
          </Badge>
        );
      case "revoked":
        return (
          <Badge variant="destructive">
            <XCircle className="h-3 w-3 mr-1" />
            Revoked
          </Badge>
        );
      default:
        return (
          <Badge variant="secondary">
            Disconnected
          </Badge>
        );
    }
  };

  return (
    <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-2xl">
      <div className="mb-8">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/settings")}
          className="mb-4"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Settings
        </Button>
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <Calendar className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Google Calendar</h1>
            <p className="text-muted-foreground">
              Import events from Google Calendar
            </p>
          </div>
        </div>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {ERROR_MESSAGES[error] || "An error occurred. Please try again."}
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-6">
        {/* Connection Status Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">Connection Status</CardTitle>
              {!loading && getStatusBadge()}
            </div>
            <CardDescription>
              Connect your Google Calendar to import events
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-10 w-32" />
              </div>
            ) : connection ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between py-2 border-b">
                  <span className="text-sm text-muted-foreground">Connected as</span>
                  <span className="font-medium">{connection.googleEmail}</span>
                </div>
                {connection.lastSyncAt && (
                  <div className="flex items-center justify-between py-2 border-b">
                    <span className="text-sm text-muted-foreground">Last synced</span>
                    <span className="text-sm">
                      {formatLastSync(connection.lastSyncAt)}
                    </span>
                  </div>
                )}
                {connection.lastSyncError && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      Last sync failed: {connection.lastSyncError}
                    </AlertDescription>
                  </Alert>
                )}
                {!isActiveConnection && connection.statusMessage && (
                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{connection.statusMessage}</AlertDescription>
                  </Alert>
                )}
                <div className="flex gap-2 pt-2">
                  {isActiveConnection ? (
                    <Button
                      variant="default"
                      size="sm"
                      disabled={syncing || disconnecting}
                      onClick={() => handleSync()}
                    >
                      {syncing ? (
                        <>
                          <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                          Syncing...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-4 w-4 mr-2" />
                          Sync Now
                        </>
                      )}
                    </Button>
                  ) : (
                    <Button
                      variant="default"
                      size="sm"
                      disabled={connecting || disconnecting}
                      onClick={handleConnect}
                    >
                      {connecting ? (
                        <>
                          <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                          Reconnecting...
                        </>
                      ) : (
                        <>
                          <ExternalLink className="h-4 w-4 mr-2" />
                          Reconnect
                        </>
                      )}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disconnecting || syncing || connecting}
                    onClick={handleDisconnect}
                  >
                    {disconnecting ? (
                      <>
                        <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                        Disconnecting...
                      </>
                    ) : (
                      "Disconnect"
                    )}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="text-sm text-muted-foreground">
                  <p className="mb-3">Benefits of connecting:</p>
                  <ul className="list-disc list-inside space-y-1 ml-2">
                    <li>AI can see your real availability</li>
                    <li>Schedule around existing commitments</li>
                    <li>No manual event recreation</li>
                  </ul>
                </div>
                <Button
                  onClick={handleConnect}
                  disabled={connecting}
                >
                  {connecting ? (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      Connecting...
                    </>
                  ) : (
                    <>
                      <ExternalLink className="h-4 w-4 mr-2" />
                      Connect Google Calendar
                    </>
                  )}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Info Card */}
        <Card className="bg-muted/50">
          <CardContent className="pt-6">
            <div className="flex gap-3">
              <AlertCircle className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
              <div className="text-sm text-muted-foreground">
                <p className="font-medium mb-1">Privacy & Data</p>
                <p>
                  PageSpace imports event details (titles, times, locations, descriptions, and
                  recurrence rules) from your calendar using read-only access. Your calendar data
                  is stored encrypted, never shared with third parties, and never used for
                  advertising. You can disconnect at any time.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
