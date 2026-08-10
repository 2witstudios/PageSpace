"use client";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Defaults</CardTitle>
          <CardDescription>Applied to every spawn unless overridden in the dialog.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Default runtime</Label>
              <Select defaultValue="claude">
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude">Claude</SelectItem>
                  <SelectItem value="codex">Codex</SelectItem>
                  <SelectItem value="terminal">Plain terminal</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Default workspace size</Label>
              <Select defaultValue="performance-2x">
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="shared-1x">shared-1x · 2 GB</SelectItem>
                  <SelectItem value="performance-2x">performance-2x · 4 GB</SelectItem>
                  <SelectItem value="performance-4x">performance-4x · 8 GB</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button size="sm" onClick={() => toast.success("Mock: defaults saved")}>
            Save
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Access</CardTitle>
          <CardDescription>
            The PageSpace API key this app will act with. Mock — nothing is stored.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="api-key">API key</Label>
            <Input id="api-key" type="password" placeholder="ps_at_••••••••••••" className="font-mono text-sm" />
          </div>
          <Button variant="outline" size="sm" onClick={() => toast("Mock: key validated")}>
            Validate
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
