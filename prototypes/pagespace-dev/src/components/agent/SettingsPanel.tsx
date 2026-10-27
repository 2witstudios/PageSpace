"use client";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { checkoutLabel } from "@/components/fleet/AgentCard";
import type { Agent } from "@/lib/mock/types";

export default function SettingsPanel({ agent }: { agent: Agent }) {
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Session</CardTitle>
          <CardDescription>Identity is minted at spawn; the name is yours to change.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="agent-name">Name</Label>
            <Input id="agent-name" defaultValue={agent.name} className="font-mono text-sm" />
          </div>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Runtime</div>
              <div className="mt-0.5 capitalize">{agent.runtime}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Checkout</div>
              <div className="mt-0.5 truncate font-mono text-xs">{checkoutLabel(agent)}</div>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <div>
              <div className="text-sm">Run idle triggers</div>
              <div className="text-xs text-muted-foreground">
                Fire <span className="font-mono">agent_idle</span> sequences when this agent goes quiet.
              </div>
            </div>
            <Switch defaultChecked onCheckedChange={() => toast("Mock: trigger opt-out flipped")} />
          </div>
          <Button size="sm" onClick={() => toast.success("Mock: settings saved")}>
            Save
          </Button>
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-base text-destructive">Danger zone</CardTitle>
          <CardDescription>
            Destroying the agent removes its session AND its checkout from the workspace.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            size="sm"
            className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => toast.error(`Mock: ${agent.name} destroyed`)}
          >
            Destroy agent
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
