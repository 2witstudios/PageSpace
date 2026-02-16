'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Plus, Trash2 } from 'lucide-react';

export interface SchemaParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'integer';
  description: string;
  required: boolean;
}

interface JsonSchemaBuilderProps {
  parameters: SchemaParameter[];
  onChange: (parameters: SchemaParameter[]) => void;
}

export function JsonSchemaBuilder({ parameters, onChange }: JsonSchemaBuilderProps) {
  const addParameter = () => {
    onChange([...parameters, { name: '', type: 'string', description: '', required: false }]);
  };

  const removeParameter = (index: number) => {
    onChange(parameters.filter((_, i) => i !== index));
  };

  const updateParameter = (index: number, updates: Partial<SchemaParameter>) => {
    onChange(parameters.map((p, i) => i === index ? { ...p, ...updates } : p));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">Parameters</Label>
        <Button type="button" variant="outline" size="sm" onClick={addParameter}>
          <Plus className="h-3 w-3 mr-1" />
          Add
        </Button>
      </div>

      {parameters.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-3">
          No parameters defined. Click Add to create one.
        </p>
      ) : (
        <div className="space-y-3">
          {parameters.map((param, index) => (
            <div key={index} className="grid grid-cols-12 gap-2 items-start border rounded-md p-2">
              <div className="col-span-3">
                <Input
                  placeholder="name"
                  value={param.name}
                  onChange={(e) => updateParameter(index, { name: e.target.value })}
                  className="h-8 text-xs"
                  aria-label={`Parameter ${index + 1} name`}
                />
              </div>
              <div className="col-span-2">
                <Select
                  value={param.type}
                  onValueChange={(v) => updateParameter(index, { type: v as SchemaParameter['type'] })}
                >
                  <SelectTrigger className="h-8 text-xs" aria-label={`Parameter ${index + 1} type`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="string">string</SelectItem>
                    <SelectItem value="number">number</SelectItem>
                    <SelectItem value="integer">integer</SelectItem>
                    <SelectItem value="boolean">boolean</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-4">
                <Input
                  placeholder="description"
                  value={param.description}
                  onChange={(e) => updateParameter(index, { description: e.target.value })}
                  className="h-8 text-xs"
                  aria-label={`Parameter ${index + 1} description`}
                />
              </div>
              <div className="col-span-2 flex items-center gap-1 h-8">
                <Checkbox
                  id={`req-${index}`}
                  checked={param.required}
                  onCheckedChange={(c) => updateParameter(index, { required: !!c })}
                />
                <label htmlFor={`req-${index}`} className="text-[10px] text-muted-foreground">
                  Req
                </label>
              </div>
              <div className="col-span-1 flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => removeParameter(index)}
                  aria-label="Remove parameter"
                >
                  <Trash2 className="h-3 w-3 text-destructive" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Convert SchemaParameter[] to a JSON Schema object for the tool's inputSchema.
 */
export function parametersToJsonSchema(parameters: SchemaParameter[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of parameters) {
    if (!param.name.trim()) continue;
    properties[param.name] = {
      type: param.type,
      ...(param.description ? { description: param.description } : {}),
    };
    if (param.required) {
      required.push(param.name);
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}
