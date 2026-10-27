"use client";

import { toast } from "sonner";
import { CalendarClock, Plus, ShieldCheck, Syringe, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { schedules, triggers } from "@/lib/mock/automations";
import type { TriggerEvent } from "@/lib/mock/types";

const EVENT_LABEL: Record<TriggerEvent, string> = {
  agent_idle: "agent idle",
  pre_commit: "pre-commit",
  pre_push: "pre-push",
  task_status: "task status",
};

/**
 * Workflows — PageSpace's own primitive, not a parallel one. Event-driven
 * workflows (task status changes, agent idle, git gates) on one tab; the
 * Calendar tab is calendar events carrying agent-spawning triggers, so every
 * schedule also appears in the drive calendar.
 */
export default function WorkflowsPage() {
  return (
    <div className="mx-auto max-w-4xl p-6">
      <Tabs defaultValue="workflows">
        <div className="flex items-center justify-between">
          <TabsList>
            <TabsTrigger value="workflows">Workflows</TabsTrigger>
            <TabsTrigger value="calendar">Calendar</TabsTrigger>
          </TabsList>
          <Button size="sm" className="gap-1.5" onClick={() => toast("Mock: create dialog")}>
            <Plus className="size-4" />
            New
          </Button>
        </div>

        <TabsContent value="workflows" className="mt-4 space-y-3">
          {triggers.map((trigger) => (
            <div key={trigger.name} className="rounded-lg border border-border bg-card p-4 shadow-[var(--shadow-ambient)]">
              <div className="flex items-center gap-2">
                <Zap className="size-4 text-primary" />
                <span className="font-mono text-sm font-semibold">{trigger.name}</span>
                <span className="rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
                  {EVENT_LABEL[trigger.event]}
                </span>
                <div className="flex-1" />
                <Switch
                  defaultChecked={trigger.enabled}
                  onCheckedChange={(on) => toast(`Mock: ${trigger.name} ${on ? "enabled" : "disabled"}`)}
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{trigger.description}</p>
              <ol className="mt-3 space-y-1.5">
                {trigger.steps.map((step, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="w-4 text-right font-mono text-muted-foreground">{i + 1}.</span>
                    {step.inject && (
                      <span className="inline-flex items-center gap-1 rounded-sm bg-info/10 px-1.5 py-0.5 font-mono text-[11px] text-info">
                        <Syringe className="size-3" />
                        {step.inject}
                      </span>
                    )}
                    {step.gate && (
                      <span className="inline-flex items-center gap-1 rounded-sm bg-success/10 px-1.5 py-0.5 font-mono text-[11px] text-success">
                        <ShieldCheck className="size-3" />
                        {step.gate.run} → exit {step.gate.expectExit}
                      </span>
                    )}
                    {step.maxRetries !== undefined && (
                      <span className="text-[11px] text-muted-foreground">retries ≤ {step.maxRetries}</span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </TabsContent>

        <TabsContent value="calendar" className="mt-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            Calendar events with agent-spawning triggers — they live on the drive calendar too.
          </p>
          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Next run</TableHead>
                  <TableHead>Recurrence</TableHead>
                  <TableHead>Spawns</TableHead>
                  <TableHead className="text-right">Enabled</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedules.map((s) => (
                  <TableRow key={s.name}>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <CalendarClock className="size-3.5 text-muted-foreground" />
                        <span className="font-mono text-xs">{s.name}</span>
                      </div>
                      <div className="mt-0.5 max-w-64 truncate pl-5 text-[11px] text-muted-foreground">
                        {s.triggerType === "inline-prompt" ? s.triggerRef : `${s.triggerType}: ${s.triggerRef}`}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">{s.nextRun}</TableCell>
                    <TableCell>
                      <span className="rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {s.recurrence}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs capitalize text-muted-foreground">{s.mode}</TableCell>
                    <TableCell className="text-right">
                      <Switch
                        defaultChecked={s.enabled}
                        onCheckedChange={(on) => toast(`Mock: ${s.name} ${on ? "enabled" : "disabled"}`)}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
