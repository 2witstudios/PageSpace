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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { put } from '@/lib/auth/auth-fetch';
import { JsonSchemaBuilder, parametersToJsonSchema, type SchemaParameter } from './JsonSchemaBuilder';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type ToolCategory = 'read' | 'write' | 'admin' | 'dangerous';

interface ToolBuilderProps {
  providerId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function ToolBuilder({ providerId, open, onOpenChange, onSaved }: ToolBuilderProps) {
  const [toolName, setToolName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<ToolCategory>('read');
  const [method, setMethod] = useState<HttpMethod>('GET');
  const [pathTemplate, setPathTemplate] = useState('');
  const [parameters, setParameters] = useState<SchemaParameter[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  const resetForm = () => {
    setToolName('');
    setDescription('');
    setCategory('read');
    setMethod('GET');
    setPathTemplate('');
    setParameters([]);
  };

  const handleSave = async () => {
    if (!toolName.trim() || !pathTemplate.trim()) {
      toast.error('Tool name and path template are required');
      return;
    }

    setIsSaving(true);
    try {
      const tool = {
        id: toolName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_'),
        name: toolName.trim(),
        description: description.trim(),
        category,
        inputSchema: parametersToJsonSchema(parameters),
        execution: {
          type: 'http',
          config: {
            method,
            pathTemplate: pathTemplate.trim(),
          },
        },
      };

      await put(`/api/integrations/providers/${providerId}`, {
        addTools: [tool],
      });

      toast.success(`Tool "${toolName}" added`);
      onSaved();
      onOpenChange(false);
      resetForm();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save tool');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) resetForm(); onOpenChange(o); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Custom Tool</DialogTitle>
          <DialogDescription>
            Define a new API tool that AI agents can call.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="tool-name">Tool Name</Label>
            <Input
              id="tool-name"
              value={toolName}
              onChange={(e) => setToolName(e.target.value)}
              placeholder="e.g., get_user_profile"
              maxLength={100}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="tool-desc">Description</Label>
            <Textarea
              id="tool-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this tool do?"
              className="min-h-[60px]"
              maxLength={500}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Category</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as ToolCategory)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="read">Read</SelectItem>
                  <SelectItem value="write">Write</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="dangerous">Dangerous</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>HTTP Method</Label>
              <Select value={method} onValueChange={(v) => setMethod(v as HttpMethod)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="GET">GET</SelectItem>
                  <SelectItem value="POST">POST</SelectItem>
                  <SelectItem value="PUT">PUT</SelectItem>
                  <SelectItem value="PATCH">PATCH</SelectItem>
                  <SelectItem value="DELETE">DELETE</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="path-template">Path Template</Label>
            <Input
              id="path-template"
              value={pathTemplate}
              onChange={(e) => setPathTemplate(e.target.value)}
              placeholder="/users/{id}"
              className="font-mono text-sm"
            />
            <p className="text-[10px] text-muted-foreground">
              Use {'{param}'} for path parameters.
            </p>
          </div>

          <JsonSchemaBuilder parameters={parameters} onChange={setParameters} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={isSaving || !toolName.trim() || !pathTemplate.trim()}>
            {isSaving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              'Add Tool'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
