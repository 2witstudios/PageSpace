"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { Download, Loader2, Clock } from "lucide-react";
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

export function DataPrivacySection() {
  const [isExporting, setIsExporting] = useState(false);
  const [exportCooldown, setExportCooldown] = useState<string | null>(null);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const response = await fetchWithAuth('/api/account/export');

      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '0', 10);
        const hours = Math.floor(retryAfter / 3600);
        const minutes = Math.ceil((retryAfter % 3600) / 60);
        const parts: string[] = [];
        if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
        if (minutes > 0) parts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`);
        setExportCooldown(parts.join(' and ') || 'a few moments');
        toast.error('Export limit reached. Please try again later.');
        return;
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to export data');
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pagespace-data-export-${new Date().toISOString().split('T')[0]}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setExportCooldown(null);
      toast.success('Your data export has been downloaded.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to export data');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Data & Privacy</CardTitle>
        <CardDescription>Download a copy of all your data stored in PageSpace</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Export a ZIP archive containing your profile information, drives, pages, messages, files, AI conversations, connections, and activity logs.
        </p>
        {exportCooldown && (
          <Alert>
            <Clock className="h-4 w-4" />
            <AlertDescription>You can request another export in {exportCooldown}.</AlertDescription>
          </Alert>
        )}
        <Button onClick={handleExport} disabled={isExporting}>
          {isExporting ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Preparing Export...</>
          ) : (
            <><Download className="mr-2 h-4 w-4" />Download My Data</>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
