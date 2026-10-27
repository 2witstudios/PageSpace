"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { workspaces } from "@/lib/mock/workspaces";
import { commands } from "@/lib/mock/commands";
import { allTasks } from "@/lib/mock/tasks";
import type { AgentRuntime } from "@/lib/mock/types";

/** Every spawnable checkout, flattened for the cascade picker. */
function checkoutOptions() {
  return workspaces
    .filter((ws) => ws.status === "ready")
    .flatMap((ws) =>
      ws.repos.flatMap((repo) =>
        repo.branches.map((b) => ({
          value: `${ws.id} ${repo.name} ${b.name}`,
          label: `${ws.name} / ${repo.name} @ ${b.name}`,
        })),
      ),
    );
}

/**
 * Tasks a session can ground on: has a spec, not in a done status, and no
 * session already assigned. (Assignment is the join between the drive/task
 * hierarchy and the machine/branch hierarchy — spawning here creates it.)
 */
function groundableTasks() {
  return allTasks().filter(
    (t) =>
      t.spec &&
      t.status !== "completed" &&
      !t.assignees.some((a) => a.kind === "session"),
  );
}

/**
 * The spawn act (⌘K). The primary path is grounding on a task — the task's
 * spec IS the prompt (the unlock over PurePoint, DESIGN.md §2.5); a free
 * prompt and drive commands remain for ad-hoc work. Names are minted, not
 * asked for. Mock phase: "Spawn" just toasts.
 */
export default function SpawnDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [runtime, setRuntime] = useState<AgentRuntime>("claude");
  const [checkout, setCheckout] = useState<string>("");
  const [command, setCommand] = useState<string>("none");
  const [taskId, setTaskId] = useState<string>("none");
  const [planMode, setPlanMode] = useState(false);
  const checkouts = useMemo(() => checkoutOptions(), []);
  const tasks = useMemo(() => groundableTasks(), []);

  const groundOnTask = (id: string) => {
    setTaskId(id);
    const task = tasks.find((t) => t.id === id);
    // The spec becomes the prompt — visibly, so the "tasks are prompts" model
    // is legible in the UI rather than implied.
    setPrompt(task?.spec ?? "");
  };

  const spawn = () => {
    const where = checkouts.find((c) => c.value === checkout)?.label ?? "a new checkout";
    const task = tasks.find((t) => t.id === taskId);
    toast.success(`Mock: spawned a ${runtime} agent into ${where}`, {
      description: task
        ? `Grounded on "${task.title}" — it will move the task as it works.`
        : planMode
          ? "Starting in plan mode."
          : prompt || "No first prompt — landing at the REPL.",
    });
    onOpenChange(false);
    setPrompt("");
    setTaskId("none");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="size-4 text-primary" />
            Spawn an agent
          </DialogTitle>
          <DialogDescription>
            Ground it on a task — the spec is the prompt — or hand it one directly. Names are minted.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Ground on task</Label>
            <Select value={taskId} onValueChange={groundOnTask}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="None — free prompt" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None — free prompt</SelectItem>
                {tasks.map((t) => (
                  <SelectItem key={t.id} value={t.id} className="text-xs">
                    {t.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="spawn-prompt">Prompt{taskId !== "none" && " (from the task's spec)"}</Label>
            <Textarea
              id="spawn-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Fix the desktop logout regression — start from the failing AuthProvider test."
              className="min-h-24 font-mono text-xs"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Runtime</Label>
              <Select value={runtime} onValueChange={(v) => setRuntime(v as AgentRuntime)}>
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
              <Label>Command</Label>
              <Select value={command} onValueChange={setCommand}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {commands.map((c) => (
                    <SelectItem key={c.name} value={c.name} className="font-mono text-xs">
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Checkout</Label>
            <Select value={checkout} onValueChange={setCheckout}>
              <SelectTrigger className="w-full font-mono text-xs">
                <SelectValue placeholder="workspace / repo @ branch" />
              </SelectTrigger>
              <SelectContent>
                {checkouts.map((c) => (
                  <SelectItem key={c.value} value={c.value} className="font-mono text-xs">
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <div>
              <div className="text-sm">Plan mode</div>
              <div className="text-xs text-muted-foreground">
                The agent proposes a plan before touching files.
              </div>
            </div>
            <Switch checked={planMode} onCheckedChange={setPlanMode} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={spawn} disabled={!checkout}>
            Spawn
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
