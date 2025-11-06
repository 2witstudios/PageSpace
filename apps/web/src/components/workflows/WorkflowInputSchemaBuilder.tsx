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
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { X, Plus } from 'lucide-react';

interface InputField {
  id: string;
  name: string;
  type: 'text' | 'textarea' | 'number' | 'email' | 'select' | 'checkbox';
  required: boolean;
  defaultValue?: string;
  options?: string[]; // For select type
}

interface WorkflowInputSchemaBuilderProps {
  schema: Record<string, unknown> | null;
  onChange: (schema: Record<string, unknown> | null) => void;
}

export function WorkflowInputSchemaBuilder({
  schema,
  onChange,
}: WorkflowInputSchemaBuilderProps) {
  const [fields, setFields] = useState<InputField[]>(() => {
    if (!schema || !schema.fields) return [];
    return (schema.fields as InputField[]) || [];
  });

  const addField = () => {
    const newField: InputField = {
      id: `field_${Date.now()}`,
      name: '',
      type: 'text',
      required: false,
    };
    const updatedFields = [...fields, newField];
    setFields(updatedFields);
    updateSchema(updatedFields);
  };

  const removeField = (id: string) => {
    const updatedFields = fields.filter((f) => f.id !== id);
    setFields(updatedFields);
    updateSchema(updatedFields);
  };

  const updateField = (id: string, updates: Partial<InputField>) => {
    const updatedFields = fields.map((f) =>
      f.id === id ? { ...f, ...updates } : f
    );
    setFields(updatedFields);
    updateSchema(updatedFields);
  };

  const updateSchema = (updatedFields: InputField[]) => {
    if (updatedFields.length === 0) {
      onChange(null);
    } else {
      onChange({ fields: updatedFields });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label>User Input Fields</Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addField}
        >
          <Plus className="size-4 mr-2" />
          Add Field
        </Button>
      </div>

      {fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No input fields defined. Click "Add Field" to create one.
        </p>
      ) : (
        <div className="space-y-3">
          {fields.map((field) => (
            <Card key={field.id}>
              <CardContent className="pt-4 space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor={`${field.id}-name`} className="text-xs">
                        Field Name
                      </Label>
                      <Input
                        id={`${field.id}-name`}
                        value={field.name}
                        onChange={(e) =>
                          updateField(field.id, { name: e.target.value })
                        }
                        placeholder="e.g., userEmail"
                        className="h-8"
                      />
                    </div>

                    <div>
                      <Label htmlFor={`${field.id}-type`} className="text-xs">
                        Field Type
                      </Label>
                      <Select
                        value={field.type}
                        onValueChange={(value) =>
                          updateField(field.id, {
                            type: value as InputField['type'],
                          })
                        }
                      >
                        <SelectTrigger id={`${field.id}-type`} className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="text">Text</SelectItem>
                          <SelectItem value="textarea">Textarea</SelectItem>
                          <SelectItem value="number">Number</SelectItem>
                          <SelectItem value="email">Email</SelectItem>
                          <SelectItem value="select">Select</SelectItem>
                          <SelectItem value="checkbox">Checkbox</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeField(field.id)}
                    className="shrink-0 h-8 w-8 p-0 mt-5"
                  >
                    <X className="size-4" />
                  </Button>
                </div>

                <div className="flex items-center gap-4">
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id={`${field.id}-required`}
                      checked={field.required}
                      onCheckedChange={(checked) =>
                        updateField(field.id, { required: checked === true })
                      }
                    />
                    <Label
                      htmlFor={`${field.id}-required`}
                      className="text-xs font-normal"
                    >
                      Required
                    </Label>
                  </div>

                  <div className="flex-1">
                    <Label htmlFor={`${field.id}-default`} className="text-xs">
                      Default Value
                    </Label>
                    <Input
                      id={`${field.id}-default`}
                      value={field.defaultValue || ''}
                      onChange={(e) =>
                        updateField(field.id, { defaultValue: e.target.value })
                      }
                      placeholder="Optional"
                      className="h-8"
                    />
                  </div>
                </div>

                {field.type === 'select' && (
                  <div>
                    <Label htmlFor={`${field.id}-options`} className="text-xs">
                      Options (comma-separated)
                    </Label>
                    <Input
                      id={`${field.id}-options`}
                      value={(field.options || []).join(', ')}
                      onChange={(e) =>
                        updateField(field.id, {
                          options: e.target.value
                            .split(',')
                            .map((o) => o.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder="Option 1, Option 2, Option 3"
                      className="h-8"
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
