"use client";

import { useState, useEffect, useCallback, type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { AlertCircle, ChevronDown, ChevronRight, MessageSquare, RefreshCw, Wrench } from "lucide-react";
import { fetchWithAuth } from "@/lib/auth/auth-fetch";
import type { GlobalPromptResponse, RolePromptData, PromptSection, ToolSchemaInfo } from "./types";

function fmt(n: number) {
  return n.toLocaleString();
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
        <span className="text-xs text-muted-foreground shrink-0 ml-2">{fmt(section.tokens)} tok</span>
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
            <TableCell className="text-right text-xs text-muted-foreground">{fmt(tool.tokenEstimate)}</TableCell>
            <TableCell className="text-xs text-muted-foreground max-w-sm truncate">{tool.description}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CollapsibleBlock({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 py-2 text-sm hover:bg-muted/50 px-2 rounded w-full">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="font-medium">{label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ScrollArea className="h-64 mt-1 mb-2">
          {children}
        </ScrollArea>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ModePanel({ data, tools }: { data: RolePromptData; tools: ToolSchemaInfo[] }) {
  const totalToolTokens = tools.reduce((s, t) => s + t.tokenEstimate, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 text-sm">
        <Badge variant="secondary">{fmt(data.totalTokens)} prompt tokens</Badge>
        <Badge variant="secondary">{fmt(totalToolTokens)} tool tokens</Badge>
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

      {tools.length > 0 && (
        <>
          <Separator />
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Wrench className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-semibold">Tools ({tools.length})</span>
            </div>
            <ToolsTable tools={tools} />
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
          <CollapsibleBlock label={`Complete Payload (raw) — ${fmt(data.completePayload.tokenEstimates.total)} tok`}>
            <pre className="text-xs bg-muted/50 rounded p-3 whitespace-pre-wrap break-words font-mono leading-relaxed">
              {data.completePayload.formattedString}
            </pre>
          </CollapsibleBlock>
        </>
      )}
    </div>
  );
}

export default function GlobalPromptPage() {
  const [data, setData] = useState<GlobalPromptResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDriveId, setSelectedDriveId] = useState<string>("");
  const [selectedPageId, setSelectedPageId] = useState<string>("");

  const fetchData = useCallback(async (driveId: string, pageId: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (driveId) params.set("driveId", driveId);
      if (pageId) params.set("pageId", pageId);
      const qs = params.toString();
      const res = await fetchWithAuth(`/api/admin/global-prompt${qs ? `?${qs}` : ""}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load prompt data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData("", "");
  }, [fetchData]);

  function handleDriveChange(val: string) {
    const driveId = val === "__none__" ? "" : val;
    setSelectedDriveId(driveId);
    setSelectedPageId("");
    fetchData(driveId, "");
  }

  function handlePageChange(val: string) {
    const pageId = val === "__none__" ? "" : val;
    setSelectedPageId(pageId);
    fetchData(selectedDriveId, pageId);
  }

  const availableDrives = data?.availableDrives ?? [];
  const availablePages = data?.availablePages ?? [];
  const modes = data ? Object.keys(data.promptData) : [];
  const tools = data?.toolSchemas ?? [];
  const contextLabel = data?.metadata.contextType ?? "dashboard";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageSquare className="h-4 w-4" />
              Global Prompt Viewer
            </CardTitle>
            <Badge variant="outline" className="capitalize">{contextLabel} context</Badge>
            {data && (
              <span className="text-xs text-muted-foreground ml-auto">
                {new Date(data.metadata.generatedAt).toLocaleTimeString()}
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchData(selectedDriveId, selectedPageId)}
              disabled={loading}
            >
              <RefreshCw className={`h-3 w-3 mr-1 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="flex flex-wrap gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Drive</span>
              <Select value={selectedDriveId || "__none__"} onValueChange={handleDriveChange} disabled={loading}>
                <SelectTrigger className="w-48 h-8 text-xs">
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
                <Select value={selectedPageId || "__none__"} onValueChange={handlePageChange} disabled={loading}>
                  <SelectTrigger className="w-56 h-8 text-xs">
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

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && (
        <Card>
          <CardContent className="pt-6 space-y-3">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-32 w-full" />
          </CardContent>
        </Card>
      )}

      {!loading && data && modes.length > 0 && (
        <Card>
          <CardContent className="pt-4">
            <Tabs defaultValue={modes[0]}>
              <TabsList>
                {modes.map((mode) => (
                  <TabsTrigger key={mode} value={mode} className="capitalize">
                    {mode === "fullAccess" ? "Full Access" : "Read Only"}
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
    </div>
  );
}
