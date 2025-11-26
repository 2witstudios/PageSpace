"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Copy, Check, FileCode, Coins, Wrench, Settings2, ChevronDown, ChevronUp, Maximize2, Minimize2, Search, ClipboardList } from "lucide-react";
import type { GlobalPromptResponse } from "@/lib/ai/types/global-prompt";

const COPY_FEEDBACK_DURATION = 2000;

interface GlobalPromptClientProps {
  data: GlobalPromptResponse;
}

export default function GlobalPromptClient({ data }: GlobalPromptClientProps) {
  const [selectedMode, setSelectedMode] = useState<string>("fullAccess");
  const [copiedSections, setCopiedSections] = useState<Set<string>>(new Set());
  const [copiedToolName, setCopiedToolName] = useState<string | null>(null);
  const [copiedContext, setCopiedContext] = useState(false);
  const [copiedCompletePayload, setCopiedCompletePayload] = useState(false);
  const [expandedTools, setExpandedTools] = useState<string[]>([]);
  const [isPayloadExpanded, setIsPayloadExpanded] = useState(false);
  const timeoutRefs = useRef<Map<string, NodeJS.Timeout>>(new Map());

  const currentModeData = data.promptData[selectedMode];
  const modeFilteredTools = useMemo(() =>
    data.toolSchemas?.filter(t =>
      currentModeData?.toolsAllowed.includes(t.name)
    ) || [],
    [data.toolSchemas, currentModeData?.toolsAllowed]
  );

  // Cleanup timeouts on unmount
  useEffect(() => {
    const refs = timeoutRefs.current;
    return () => {
      refs.forEach(clearTimeout);
      refs.clear();
    };
  }, []);

  // Helper to set a tracked timeout
  const setTrackedTimeout = useCallback((key: string, callback: () => void) => {
    // Clear existing timeout for this key if any
    const existing = timeoutRefs.current.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timeoutId = setTimeout(() => {
      callback();
      timeoutRefs.current.delete(key);
    }, COPY_FEEDBACK_DURATION);
    timeoutRefs.current.set(key, timeoutId);
  }, []);

  // Clipboard helper with error handling
  const copyToClipboard = useCallback(async (
    text: string,
    onSuccess: () => void
  ) => {
    try {
      await navigator.clipboard.writeText(text);
      onSuccess();
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  }, []);

  const handleCopySection = useCallback(async (sectionName: string, content: string) => {
    await copyToClipboard(content, () => {
      setCopiedSections(prev => new Set(prev).add(sectionName));
      setTrackedTimeout(`section-${sectionName}`, () => {
        setCopiedSections(prev => {
          const next = new Set(prev);
          next.delete(sectionName);
          return next;
        });
      });
    });
  }, [copyToClipboard, setTrackedTimeout]);

  const handleCopyTool = useCallback(async (toolName: string, content: string) => {
    await copyToClipboard(content, () => {
      setCopiedToolName(toolName);
      setTrackedTimeout(`tool-${toolName}`, () => setCopiedToolName(null));
    });
  }, [copyToClipboard, setTrackedTimeout]);

  const handleCopyContext = useCallback(async () => {
    await copyToClipboard(JSON.stringify(data.experimentalContext, null, 2), () => {
      setCopiedContext(true);
      setTrackedTimeout('context', () => setCopiedContext(false));
    });
  }, [data.experimentalContext, copyToClipboard, setTrackedTimeout]);

  const handleCopyCompletePayload = useCallback(async () => {
    const payload = currentModeData?.completePayload?.formattedString;
    if (!payload) return;
    await copyToClipboard(payload, () => {
      setCopiedCompletePayload(true);
      setTrackedTimeout('completePayload', () => setCopiedCompletePayload(false));
    });
  }, [currentModeData?.completePayload?.formattedString, copyToClipboard, setTrackedTimeout]);

  const handleToggleExpandAll = useCallback(() => {
    if (expandedTools.length > 0) {
      setExpandedTools([]);
    } else {
      setExpandedTools(modeFilteredTools.map((_, i) => `tool-${i}`));
    }
  }, [expandedTools.length, modeFilteredTools]);

  if (!currentModeData) {
    return <div>No data available for this mode</div>;
  }

  // Filter tools by mode permissions
  const allowedToolNames = new Set(currentModeData.toolsAllowed);
  const deniedTools = data.toolSchemas?.filter(t => !allowedToolNames.has(t.name)) || [];

  return (
    <div className="space-y-6">
      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* SECTION 1: PROMPT EXPLORER - Interactive cards for browsing    */}
      {/* ═══════════════════════════════════════════════════════════════ */}

      {/* Section Header */}
      <div className="flex items-center gap-3 pb-2 border-b">
        <Search className="h-5 w-5 text-muted-foreground" />
        <div>
          <h2 className="text-lg font-semibold">Prompt Explorer</h2>
          <p className="text-sm text-muted-foreground">Browse and inspect individual components of the system prompt</p>
        </div>
      </div>

      {/* Mode Selector */}
      <Card>
        <CardHeader>
          <CardTitle>Access Mode</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs value={selectedMode} onValueChange={setSelectedMode}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="fullAccess">Full Access</TabsTrigger>
              <TabsTrigger value="readOnly">Read-Only</TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Mode Info */}
          <div className="mt-4 space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Total Tokens:</span>
              <Badge variant="secondary" className="gap-1">
                <Coins className="h-3 w-3" />
                {currentModeData.totalTokens.toLocaleString()}
              </Badge>
            </div>

            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Permissions:</span>
              <div className="flex gap-2">
                {currentModeData.permissions.canRead && (
                  <Badge variant="outline">Read</Badge>
                )}
                {currentModeData.permissions.canWrite && (
                  <Badge variant="outline">Write</Badge>
                )}
                {currentModeData.permissions.canDelete && (
                  <Badge variant="outline">Delete</Badge>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Tools Available:</span>
              <Badge variant="secondary">
                {currentModeData.toolsAllowed.length} / {currentModeData.toolsAllowed.length + currentModeData.toolsDenied.length}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Prompt Sections */}
      <Card>
        <CardHeader>
          <CardTitle>Prompt Sections</CardTitle>
        </CardHeader>
        <CardContent>
          <Accordion type="multiple" className="w-full">
            {currentModeData.sections.map((section, index) => {
              const isCopied = copiedSections.has(section.name);
              return (
                <AccordionItem key={index} value={`section-${index}`}>
                  <AccordionTrigger className="hover:no-underline">
                    <div className="flex items-center justify-between w-full pr-4">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{section.name}</span>
                        <Badge variant="secondary" className="gap-1">
                          <Coins className="h-3 w-3" />
                          {section.tokens}
                        </Badge>
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-3">
                      {/* Source Info */}
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <FileCode className="h-3 w-3" />
                        <code className="bg-muted px-2 py-0.5 rounded">
                          {section.source}
                          {section.lines && `:${section.lines}`}
                        </code>
                      </div>

                      {/* Content */}
                      <div className="relative">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleCopySection(section.name, section.content)}
                          className="absolute top-2 right-2 z-10 gap-1"
                        >
                          {isCopied ? (
                            <>
                              <Check className="h-3 w-3" />
                              Copied
                            </>
                          ) : (
                            <>
                              <Copy className="h-3 w-3" />
                              Copy
                            </>
                          )}
                        </Button>
                        <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-xs whitespace-pre-wrap font-mono">
                          {section.content}
                        </pre>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        </CardContent>
      </Card>

      {/* Tool Definitions with Full Schemas */}
      {data.toolSchemas && data.toolSchemas.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <Wrench className="h-5 w-5" />
                Tool Definitions ({modeFilteredTools.length} available in {selectedMode === 'fullAccess' ? 'Full Access' : 'Read-Only'} mode)
              </CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={handleToggleExpandAll}
                className="gap-2"
              >
                {expandedTools.length > 0 ? (
                  <>
                    <ChevronUp className="h-4 w-4" />
                    Collapse All
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-4 w-4" />
                    Expand All
                  </>
                )}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <Accordion
              type="multiple"
              className="w-full"
              value={expandedTools}
              onValueChange={setExpandedTools}
            >
              {modeFilteredTools.map((tool, index) => {
                const isCopied = copiedToolName === tool.name;
                const toolJson = JSON.stringify({
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                }, null, 2);

                return (
                  <AccordionItem key={tool.name} value={`tool-${index}`}>
                    <AccordionTrigger className="hover:no-underline">
                      <div className="flex items-center justify-between w-full pr-4">
                        <div className="flex items-center gap-2">
                          <code className="font-mono font-medium text-sm">{tool.name}</code>
                          <Badge variant="secondary" className="gap-1">
                            <Coins className="h-3 w-3" />
                            ~{tool.tokenEstimate}
                          </Badge>
                        </div>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-3">
                        {/* Description */}
                        <p className="text-sm text-muted-foreground">{tool.description}</p>

                        {/* Parameters Schema */}
                        <div className="relative">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleCopyTool(tool.name, toolJson)}
                            className="absolute top-2 right-2 z-10 gap-1"
                          >
                            {isCopied ? (
                              <>
                                <Check className="h-3 w-3" />
                                Copied
                              </>
                            ) : (
                              <>
                                <Copy className="h-3 w-3" />
                                Copy
                              </>
                            )}
                          </Button>
                          <div className="space-y-2">
                            <h4 className="text-xs font-medium text-muted-foreground">Parameters Schema:</h4>
                            <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-xs whitespace-pre-wrap font-mono">
                              {JSON.stringify(tool.parameters, null, 2)}
                            </pre>
                          </div>
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                );
              })}
            </Accordion>

            {/* Denied Tools for this Mode */}
            {deniedTools.length > 0 && (
              <div className="mt-6 pt-6 border-t">
                <h4 className="text-sm font-medium mb-3 text-red-600 dark:text-red-400">
                  Denied Tools in {selectedMode === 'fullAccess' ? 'Full Access' : 'Read-Only'} mode ({deniedTools.length})
                </h4>
                <div className="flex flex-wrap gap-2">
                  {deniedTools.map((tool) => (
                    <Badge key={tool.name} variant="secondary" className="font-mono text-xs opacity-50">
                      {tool.name}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Legacy Tools Breakdown (if no schemas available) */}
      {(!data.toolSchemas || data.toolSchemas.length === 0) && (
        <Card>
          <CardHeader>
            <CardTitle>Tools & Permissions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <h4 className="text-sm font-medium mb-2 text-green-600 dark:text-green-400">
                Allowed Tools ({currentModeData.toolsAllowed.length})
              </h4>
              <div className="flex flex-wrap gap-2">
                {currentModeData.toolsAllowed.map((tool) => (
                  <Badge key={tool} variant="outline" className="font-mono text-xs">
                    {tool}
                  </Badge>
                ))}
              </div>
            </div>

            {currentModeData.toolsDenied.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2 text-red-600 dark:text-red-400">
                  Denied Tools ({currentModeData.toolsDenied.length})
                </h4>
                <div className="flex flex-wrap gap-2">
                  {currentModeData.toolsDenied.map((tool) => (
                    <Badge key={tool} variant="secondary" className="font-mono text-xs opacity-50">
                      {tool}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Experimental Context */}
      {data.experimentalContext && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <Settings2 className="h-5 w-5" />
                Experimental Context
              </CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyContext}
                className="gap-2"
              >
                {copiedContext ? (
                  <>
                    <Check className="h-4 w-4" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" />
                    Copy
                  </>
                )}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              This context object is passed to tool execute functions via <code className="bg-muted px-1 py-0.5 rounded">experimental_context</code>.
            </p>
            <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-xs whitespace-pre-wrap font-mono">
              {JSON.stringify(data.experimentalContext, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* SECTION 2: COMPLETE LLM PAYLOAD - The exact tokens sent to AI  */}
      {/* ═══════════════════════════════════════════════════════════════ */}

      {/* Section Header */}
      <div className="flex items-center gap-3 pb-2 border-b mt-8">
        <ClipboardList className="h-5 w-5 text-muted-foreground" />
        <div>
          <h2 className="text-lg font-semibold">Complete LLM Payload</h2>
          <p className="text-sm text-muted-foreground">The exact context window sent to the AI provider - copy this to see what the model receives</p>
        </div>
      </div>

      {/* Complete Payload */}
      {currentModeData.completePayload && (
        <Card className="border-2 border-primary/20 bg-card/50">
          <CardHeader>
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="flex flex-wrap items-center gap-4">
                <Badge variant="default" className="gap-1 text-base px-3 py-1">
                  <Coins className="h-4 w-4" />
                  ~{currentModeData.completePayload.tokenEstimates.total.toLocaleString()} tokens
                </Badge>
                <div className="flex flex-wrap gap-2 text-sm">
                  <span className="text-muted-foreground">System: {currentModeData.completePayload.tokenEstimates.systemPrompt.toLocaleString()}</span>
                  <span className="text-muted-foreground">|</span>
                  <span className="text-muted-foreground">Tools: {currentModeData.completePayload.tokenEstimates.tools.toLocaleString()}</span>
                  <span className="text-muted-foreground">|</span>
                  <span className="text-muted-foreground">Context: {currentModeData.completePayload.tokenEstimates.experimentalContext.toLocaleString()}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsPayloadExpanded(!isPayloadExpanded)}
                  className="gap-1"
                >
                  {isPayloadExpanded ? (
                    <>
                      <Minimize2 className="h-4 w-4" />
                      Collapse
                    </>
                  ) : (
                    <>
                      <Maximize2 className="h-4 w-4" />
                      Expand
                    </>
                  )}
                </Button>
                <Button
                  variant="default"
                  size="default"
                  onClick={handleCopyCompletePayload}
                  className="gap-2"
                >
                  {copiedCompletePayload ? (
                    <>
                      <Check className="h-4 w-4" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4" />
                      Copy All
                    </>
                  )}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <pre
              className={`bg-muted p-4 rounded-lg overflow-x-auto text-xs whitespace-pre-wrap font-mono transition-all ${
                isPayloadExpanded ? '' : 'max-h-[800px] overflow-y-auto'
              }`}
            >
              {currentModeData.completePayload.formattedString}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* SECTION 3: METADATA                                            */}
      {/* ═══════════════════════════════════════════════════════════════ */}

      {/* Metadata */}
      <Card>
        <CardHeader>
          <CardTitle>Context Metadata</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Generated At:</span>
            <span className="font-mono">{new Date(data.metadata.generatedAt).toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Admin User ID:</span>
            <span className="font-mono text-xs">{data.metadata.adminUser.id}</span>
          </div>
          {data.metadata.locationContext?.currentDrive && (
            <>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Context Drive:</span>
                <span className="font-mono">{data.metadata.locationContext.currentDrive.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Drive ID:</span>
                <span className="font-mono text-xs">{data.metadata.locationContext.currentDrive.id}</span>
              </div>
            </>
          )}
          {data.metadata.locationContext?.currentPage && (
            <>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Context Page:</span>
                <span className="font-mono">{data.metadata.locationContext.currentPage.title}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Page Type:</span>
                <span className="font-mono text-xs">{data.metadata.locationContext.currentPage.type}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Page Path:</span>
                <span className="font-mono text-xs">{data.metadata.locationContext.currentPage.path}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Page ID:</span>
                <span className="font-mono text-xs">{data.metadata.locationContext.currentPage.id}</span>
              </div>
            </>
          )}
          {data.metadata.locationContext?.breadcrumbs && data.metadata.locationContext.breadcrumbs.length > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Breadcrumbs:</span>
              <span className="font-mono text-xs">{data.metadata.locationContext.breadcrumbs.map(b => b.title).join(' → ')}</span>
            </div>
          )}
          {data.totalToolTokens !== undefined && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Total Tool Definition Tokens:</span>
              <span className="font-mono">{data.totalToolTokens.toLocaleString()}</span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
