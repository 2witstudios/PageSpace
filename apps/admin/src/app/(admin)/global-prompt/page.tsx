"use client";

import { Suspense, useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChevronDown, ChevronRight, MessageSquare, RefreshCw, Wrench } from "lucide-react";
import { PageHeader, DataState } from "@/components/admin/kit";
import { useAdminQuery } from "@/hooks/use-admin-query";
import { num } from "@/lib/format";
import type { GlobalPromptResponse, RolePromptData, PromptSection, ToolSchemaInfo } from "./types";

/** Render the actual mode key as a readable label ("fullAccess" -> "Full Access"). */
function formatModeLabel(mode: string): string {
  return mode
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function SectionBlock({ section }: { section: PromptSection }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between py-2 text-sm hover:bg-muted/50 px-2 rounded">
        <div className="flex items-center gap-2 min-w-0">
          {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          <span className="font-medium truncate">{section.name}</span>
          <Badge variant="outline" className="text-xs shrink-0">{section.source}</Badge>
        </div>
        <span className="text-xs text-muted-foreground shrink-0 ml-2">{num(section.tokens)} tok</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ScrollArea className="h-64 mt-1 mb-2">
          <pre className="text-xs bg-muted/50 rounded p-3 whitespace-pre-wrap break-words font-mono leading-relaxed">
            {section.content}
          </pre>
        </ScrollArea>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolsTable({ tools }: { tools: ToolSchemaInfo[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Tool</TableHead>
          <TableHead className="w-20 text-right">Tokens</TableHead>
          <TableHead>Description</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tools.map((tool) => (
          <TableRow key={tool.name}>
            <TableCell className="font-mono text-xs font-medium">{tool.name}</TableCell>
            <TableCell className="text-right text-xs text-muted-foreground">{num(tool.tokenEstimate)}</TableCell>
            <TableCell className="text-xs text-muted-foreground max-w-sm truncate">{tool.description}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CollapsibleBlock({ label, children, height = "h-64" }: { label: string; children: ReactNode; height?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 py-2 text-sm hover:bg-muted/50 px-2 rounded w-full">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="font-medium">{label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ScrollArea className={`${height} mt-1 mb-2`}>
          {children}
        </ScrollArea>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ModePanel({ data, tools }: { data: RolePromptData; tools: ToolSchemaInfo[] }) {
  const allowedNames = new Set(data.toolsAllowed);
  const modeTools = tools.filter((t) => allowedNames.has(t.name));
  const totalToolTokens = modeTools.reduce((s, t) => s + t.tokenEstimate, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 text-sm">
        <Badge variant="secondary">{num(data.totalTokens)} prompt tokens</Badge>
        <Badge variant="secondary">{num(totalToolTokens)} tool tokens</Badge>
        <Badge variant="secondary">{data.sections.length} sections</Badge>
        <Badge variant="secondary">{data.toolsAllowed.length} tools allowed</Badge>
        {data.toolsDenied.length > 0 && (
          <Badge variant="destructive">{data.toolsDenied.length} tools denied</Badge>
        )}
      </div>

      <Separator />

      <div>
        <div className="flex items-center gap-2 mb-2">
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Prompt Sections</span>
        </div>
        <div className="space-y-0.5">
          {data.sections.map((s) => (
            <SectionBlock key={s.name} section={s} />
          ))}
        </div>
      </div>

      {modeTools.length > 0 && (
        <>
          <Separator />
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Wrench className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-semibold">Tools ({modeTools.length})</span>
            </div>
            <ToolsTable tools={modeTools} />
          </div>
        </>
      )}

      {data.completePayload?.request.experimental_context && (
        <>
          <Separator />
          <CollapsibleBlock label="Experimental Context">
            <pre className="text-xs bg-muted/50 rounded p-3 whitespace-pre-wrap break-words font-mono leading-relaxed">
              {JSON.stringify(data.completePayload.request.experimental_context, null, 2)}
            </pre>
          </CollapsibleBlock>
        </>
      )}

      {data.completePayload?.formattedString && (
        <>
          <Separator />
          <CollapsibleBlock label={`Complete Payload (raw) — ${num(data.completePayload.tokenEstimates.total)} tok`} height="h-96">
            <pre className="text-xs bg-muted/50 rounded p-3 whitespace-pre-wrap break-words font-mono leading-relaxed">
              {data.completePayload.formattedString}
            </pre>
          </CollapsibleBlock>
        </>
      )}
    </div>
  );
}

function GlobalPromptContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [selectedDriveId, setSelectedDriveId] = useState<string>("");
  const [selectedPageId, setSelectedPageId] = useState<string>("");

  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (selectedDriveId) params.set("driveId", selectedDriveId);
    if (selectedPageId) params.set("pageId", selectedPageId);
    const qs = params.toString();
    return `/api/admin/global-prompt${qs ? `?${qs}` : ""}`;
  }, [selectedDriveId, selectedPageId]);

  const { data, isLoading, isFetching, error, refetch } = useAdminQuery<GlobalPromptResponse>(url);

  function handleDriveChange(val: string) {
    const driveId = val === "__none__" ? "" : val;
    setSelectedDriveId(driveId);
    setSelectedPageId("");
  }

  function handlePageChange(val: string) {
    setSelectedPageId(val === "__none__" ? "" : val);
  }

  const availableDrives = data?.availableDrives ?? [];
  const availablePages = data?.availablePages ?? [];
  const modes = data ? Object.keys(data.promptData) : [];
  const tools = data?.toolSchemas ?? [];
  const contextLabel = data?.metadata.contextType ?? "dashboard";

  const tabParam = searchParams.get("tab");
  const activeTab = tabParam && modes.includes(tabParam) ? tabParam : modes[0];

  const setTab = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", value);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Global Prompt"
        description={
          data
            ? `${formatModeLabel(contextLabel)} context — generated ${new Date(data.metadata.generatedAt).toLocaleTimeString()}`
            : "Inspect the assembled system prompt, sections, and tool payload per mode."
        }
        actions={
          <Button
            variant="outline"
            size="icon"
            className="h-10 w-10"
            onClick={refetch}
            disabled={isFetching}
            title="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        }
      />

      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Drive</span>
              <Select value={selectedDriveId || "__none__"} onValueChange={handleDriveChange} disabled={isFetching}>
                <SelectTrigger className="h-10 w-48 text-xs">
                  <SelectValue placeholder="Dashboard (no drive)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Dashboard (no drive)</SelectItem>
                  {availableDrives.map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {selectedDriveId && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Page</span>
                <Select value={selectedPageId || "__none__"} onValueChange={handlePageChange} disabled={isFetching}>
                  <SelectTrigger className="h-10 w-56 text-xs">
                    <SelectValue placeholder="Drive root" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Drive root</SelectItem>
                    {availablePages.map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.title}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <DataState
        isLoading={isLoading}
        error={error}
        isEmpty={modes.length === 0}
        emptyMessage="No prompt data returned for this context."
        onRetry={refetch}
        skeleton={
          <Card>
            <CardContent className="pt-6 space-y-3">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-32 w-full" />
            </CardContent>
          </Card>
        }
      >
        {data && modes.length > 0 && (
          <Card>
            <CardContent className="pt-4">
              <Tabs value={activeTab} onValueChange={setTab}>
                <TabsList>
                  {modes.map((mode) => (
                    <TabsTrigger key={mode} value={mode}>
                      {formatModeLabel(mode)}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {modes.map((mode) => (
                  <TabsContent key={mode} value={mode} className="mt-4">
                    <ModePanel data={data.promptData[mode]} tools={tools} />
                  </TabsContent>
                ))}
              </Tabs>
            </CardContent>
          </Card>
        )}
      </DataState>
    </div>
  );
}

export default function GlobalPromptPage() {
  return (
    <Suspense fallback={null}>
      <GlobalPromptContent />
    </Suspense>
  );
}
