'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2, AlertTriangle, FileJson, Link as LinkIcon } from 'lucide-react';
import { toast } from 'sonner';
import { post } from '@/lib/auth/auth-fetch';

interface ParsedSpec {
  provider: {
    name: string;
    description?: string;
    baseUrl: string;
    authMethod: { type: string };
    tools: Array<{
      id: string;
      name: string;
      description: string;
      category: string;
    }>;
  };
  warnings: string[];
}

interface OpenAPIImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (result: ParsedSpec) => void;
}

export function OpenAPIImportDialog({ open, onOpenChange, onImported }: OpenAPIImportDialogProps) {
  const [tab, setTab] = useState<string>('url');
  const [specUrl, setSpecUrl] = useState('');
  const [specText, setSpecText] = useState('');
  const [isFetching, setIsFetching] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [parsed, setParsed] = useState<ParsedSpec | null>(null);
  const [selectedOps, setSelectedOps] = useState<Set<string>>(new Set());

  const resetForm = () => {
    setSpecUrl('');
    setSpecText('');
    setParsed(null);
    setSelectedOps(new Set());
    setTab('url');
  };

  const handleFetchUrl = async () => {
    if (!specUrl.trim()) return;
    setIsFetching(true);
    try {
      const res = await fetch(specUrl.trim());
      if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
      const text = await res.text();
      setSpecText(text);
      await parseSpec(text);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to fetch spec');
    } finally {
      setIsFetching(false);
    }
  };

  const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      toast.error('File too large. Maximum size is 5MB.');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const text = ev.target?.result;
      if (typeof text !== 'string') return;
      setSpecText(text);
      await parseSpec(text);
    };
    reader.readAsText(file);
  };

  const parseSpec = async (spec: string) => {
    setIsFetching(true);
    try {
      const result = await post<{ result: ParsedSpec }>('/api/integrations/providers/import-openapi', {
        spec,
      });
      setParsed(result.result);
      // Select all operations by default
      const allOps = new Set(result.result.provider.tools.map((t) => t.id));
      setSelectedOps(allOps);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to parse spec');
    } finally {
      setIsFetching(false);
    }
  };

  const toggleOp = (id: string) => {
    setSelectedOps((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleImport = async () => {
    if (!parsed) return;
    setIsImporting(true);
    try {
      const result = await post<{ result: ParsedSpec }>('/api/integrations/providers/import-openapi', {
        spec: specText,
        selectedOperations: Array.from(selectedOps),
      });
      toast.success(`Imported ${selectedOps.size} tools from ${parsed.provider.name}`);
      onImported(result.result);
      onOpenChange(false);
      resetForm();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to import');
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) resetForm(); onOpenChange(o); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Import from OpenAPI</DialogTitle>
          <DialogDescription>
            Import API tools from an OpenAPI 3.x specification.
          </DialogDescription>
        </DialogHeader>

        {!parsed ? (
          <div className="space-y-4 py-2">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="w-full">
                <TabsTrigger value="url" className="flex-1">
                  <LinkIcon className="h-3.5 w-3.5 mr-1" />
                  URL
                </TabsTrigger>
                <TabsTrigger value="file" className="flex-1">
                  <FileJson className="h-3.5 w-3.5 mr-1" />
                  File
                </TabsTrigger>
              </TabsList>

              <TabsContent value="url" className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="spec-url">Spec URL</Label>
                  <div className="flex gap-2">
                    <Input
                      id="spec-url"
                      value={specUrl}
                      onChange={(e) => setSpecUrl(e.target.value)}
                      placeholder="https://api.example.com/openapi.json"
                    />
                    <Button
                      onClick={handleFetchUrl}
                      disabled={isFetching || !specUrl.trim()}
                    >
                      {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Fetch'}
                    </Button>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="file" className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="spec-file">Upload Spec File</Label>
                  <Input
                    id="spec-file"
                    type="file"
                    accept=".json,.yaml,.yml"
                    onChange={handleFileUpload}
                  />
                </div>
              </TabsContent>
            </Tabs>

            {isFetching && (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4 py-2 flex-1 overflow-hidden flex flex-col">
            {/* Spec Info */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="font-medium">{parsed.provider.name}</span>
                <Badge variant="outline" className="text-xs">
                  {parsed.provider.authMethod.type}
                </Badge>
              </div>
              {parsed.provider.description && (
                <p className="text-xs text-muted-foreground">{parsed.provider.description}</p>
              )}
              <p className="text-xs font-mono text-muted-foreground">{parsed.provider.baseUrl}</p>
            </div>

            {/* Warnings */}
            {parsed.warnings.length > 0 && (
              <div className="space-y-1">
                {parsed.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-xs text-yellow-600 dark:text-yellow-400">
                    <AlertTriangle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Tool Selection */}
            <div className="flex items-center justify-between">
              <Label className="text-sm">
                Tools ({selectedOps.size}/{parsed.provider.tools.length})
              </Label>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-6"
                onClick={() => {
                  if (selectedOps.size === parsed.provider.tools.length) {
                    setSelectedOps(new Set());
                  } else {
                    setSelectedOps(new Set(parsed.provider.tools.map((t) => t.id)));
                  }
                }}
              >
                {selectedOps.size === parsed.provider.tools.length ? 'Deselect all' : 'Select all'}
              </Button>
            </div>

            <ScrollArea className="flex-1 border rounded-md max-h-[250px]">
              <div className="p-2 space-y-1">
                {parsed.provider.tools.map((tool) => (
                  <label
                    key={tool.id}
                    className="flex items-start gap-2 p-2 rounded hover:bg-accent cursor-pointer"
                  >
                    <Checkbox
                      checked={selectedOps.has(tool.id)}
                      onCheckedChange={() => toggleOp(tool.id)}
                      className="mt-0.5"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-mono font-medium">{tool.name}</span>
                        <Badge variant="outline" className="text-[9px] px-1 py-0">
                          {tool.category}
                        </Badge>
                      </div>
                      {tool.description && (
                        <p className="text-[11px] text-muted-foreground truncate">{tool.description}</p>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            </ScrollArea>
          </div>
        )}

        <DialogFooter>
          {parsed ? (
            <>
              <Button variant="outline" onClick={() => setParsed(null)}>Back</Button>
              <Button
                onClick={handleImport}
                disabled={isImporting || selectedOps.size === 0}
              >
                {isImporting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Importing...
                  </>
                ) : (
                  `Import ${selectedOps.size} Tools`
                )}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
