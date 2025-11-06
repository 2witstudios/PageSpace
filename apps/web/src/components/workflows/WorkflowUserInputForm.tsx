'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Info, Send, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface WorkflowUserInputFormProps {
  executionId: string;
  stepOrder: number;
  inputSchema?: Record<string, unknown>;
  onSubmit: (userInput: Record<string, unknown>) => Promise<void>;
}

export function WorkflowUserInputForm({
  executionId,
  stepOrder,
  inputSchema,
  onSubmit,
}: WorkflowUserInputFormProps) {
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();

  const handleFieldChange = (fieldName: string, value: string) => {
    setFormData((prev) => ({
      ...prev,
      [fieldName]: value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      await onSubmit(formData);
      toast({
        title: 'Input submitted',
        description: 'Your input has been submitted successfully.',
      });
      setFormData({});
    } catch (error) {
      toast({
        title: 'Submission failed',
        description: error instanceof Error ? error.message : 'Failed to submit input',
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderField = (fieldName: string, fieldConfig?: unknown) => {
    const config = fieldConfig as { type?: string; description?: string; required?: boolean } | undefined;
    const fieldType = config?.type || 'string';
    const description = config?.description;
    const required = config?.required || false;

    const commonProps = {
      id: fieldName,
      value: formData[fieldName] || '',
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        handleFieldChange(fieldName, e.target.value),
      required,
    };

    return (
      <div key={fieldName} className="space-y-2">
        <Label htmlFor={fieldName} className="capitalize">
          {fieldName.replace(/([A-Z])/g, ' $1').trim()}
          {required && <span className="text-red-500 ml-1">*</span>}
        </Label>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
        {fieldType === 'string' && (
          <Input {...commonProps} type="text" />
        )}
        {fieldType === 'text' && (
          <Textarea {...commonProps} rows={4} />
        )}
        {fieldType === 'number' && (
          <Input {...commonProps} type="number" />
        )}
        {fieldType === 'email' && (
          <Input {...commonProps} type="email" />
        )}
      </div>
    );
  };

  const renderSchemaFields = () => {
    if (!inputSchema || typeof inputSchema !== 'object') {
      return (
        <div className="space-y-2">
          <Label htmlFor="userInput">Input</Label>
          <Textarea
            id="userInput"
            value={formData.userInput || ''}
            onChange={(e) => handleFieldChange('userInput', e.target.value)}
            rows={4}
            placeholder="Enter your input..."
            required
          />
        </div>
      );
    }

    const properties = (inputSchema as { properties?: Record<string, unknown> }).properties;

    if (!properties || typeof properties !== 'object') {
      return (
        <div className="space-y-2">
          <Label htmlFor="userInput">Input</Label>
          <Textarea
            id="userInput"
            value={formData.userInput || ''}
            onChange={(e) => handleFieldChange('userInput', e.target.value)}
            rows={4}
            placeholder="Enter your input..."
            required
          />
        </div>
      );
    }

    return Object.entries(properties).map(([fieldName, fieldConfig]) =>
      renderField(fieldName, fieldConfig)
    );
  };

  return (
    <Card className="border-primary bg-primary/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Info className="size-5" />
          User Input Required
        </CardTitle>
        <CardDescription>
          Step {stepOrder + 1} requires your input to continue. Please provide the information below.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Alert>
            <Info className="size-4" />
            <AlertDescription>
              The workflow will automatically continue after you submit your input.
            </AlertDescription>
          </Alert>

          {renderSchemaFields()}

          <div className="flex gap-2 justify-end pt-4">
            <Button
              type="submit"
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Submitting...
                </>
              ) : (
                <>
                  <Send className="size-4" />
                  Submit Input
                </>
              )}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
