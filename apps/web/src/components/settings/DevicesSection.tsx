"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Smartphone } from "lucide-react";
import { DeviceList } from "@/components/devices/DeviceList";
import { RevokeAllDevicesDialog } from "@/components/devices/RevokeAllDevicesDialog";

interface Device {
  id: string;
  platform: string;
  deviceName: string | null;
  lastUsedAt: string;
  isCurrent: boolean;
}
import { useState } from "react";

interface Device {
  id: string;
  userAgent: string;
  lastActiveAt: string;
  isCurrent: boolean;
}

interface DevicesSectionProps {
  devices: Device[] | undefined;
  onRefetch: () => void;
}

export function DevicesSection({ devices, onRefetch }: DevicesSectionProps) {
  const [isRevokeAllDialogOpen, setIsRevokeAllDialogOpen] = useState(false);

  return (
    <>
      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Smartphone className="h-5 w-5" />
                Connected Devices
              </CardTitle>
              <CardDescription>
                Manage devices with access to your account. Devices are automatically logged out after 90 days.
              </CardDescription>
            </div>
            {devices && devices.length > 1 && (
              <Button variant="outline" size="sm" onClick={() => setIsRevokeAllDialogOpen(true)}>
                Revoke All Others
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <DeviceList />
        </CardContent>
      </Card>

      <RevokeAllDevicesDialog
        open={isRevokeAllDialogOpen}
        onOpenChange={setIsRevokeAllDialogOpen}
        onSuccess={() => {
          onRefetch();
          setIsRevokeAllDialogOpen(false);
        }}
        deviceCount={devices?.length || 0}
      />
    </>
  );
}
