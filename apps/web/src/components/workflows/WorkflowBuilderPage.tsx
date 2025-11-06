'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ArrowLeft,
  Save,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import { WorkflowMetadataForm } from './WorkflowMetadataForm';
import { WorkflowStepBuilder } from './WorkflowStepBuilder';
import { WorkflowPreview } from './WorkflowPreview';
import { StepConfig } from './WorkflowStepCardBuilder';
import { useWorkflowTemplate } from '@/hooks/workflows/useWorkflowTemplate';
import { useAvailableAgents } from '@/hooks/workflows/useAvailableAgents';
import { useUserDrives } from '@/hooks/workflows/useUserDrives';

interface WorkflowBuilderPageProps {
  mode: 'create' | 'edit';
  templateId?: string;
}

interface FormData {
  name: string;
  description: string;
  driveId: string;
  category: string;
  tags: string[];
  isPublic: boolean;
  steps: StepConfig[];
}

interface FormErrors {
  name?: string;
  driveId?: string;
  steps?: string;
}

export function WorkflowBuilderPage({
  mode,
  templateId,
}: WorkflowBuilderPageProps) {
  const router = useRouter();
  const [isSaving, setIsSaving] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  // Fetch data
  const { template, isLoading: isLoadingTemplate } = useWorkflowTemplate(
    mode === 'edit' ? templateId || null : null
  );
  const { drives, isLoading: isLoadingDrives } = useUserDrives();

  // Form state
  const [formData, setFormData] = useState<FormData>({
    name: '',
    description: '',
    driveId: '',
    category: '',
    tags: [],
    isPublic: false,
    steps: [],
  });

  // Fetch agents based on selected drive
  const { agents, isLoading: isLoadingAgents } = useAvailableAgents(
    formData.driveId || null
  );

  // Track unsaved changes
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Load template data when editing
  useEffect(() => {
    if (mode === 'edit' && template) {
      setFormData({
        name: template.name,
        description: template.description || '',
        driveId: template.driveId,
        category: template.category || '',
        tags: template.tags || [],
        isPublic: template.isPublic,
        steps: template.steps.map((step) => ({
          id: step.id,
          stepOrder: step.stepOrder,
          agentId: step.agentId,
          promptTemplate: step.promptTemplate,
          requiresUserInput: step.requiresUserInput,
          inputSchema: step.inputSchema,
          metadata: step.metadata,
        })),
      });
    }
  }, [mode, template]);

  // Set default drive on create
  useEffect(() => {
    if (mode === 'create' && drives.length > 0 && !formData.driveId) {
      setFormData((prev) => ({ ...prev, driveId: drives[0].id }));
    }
  }, [mode, drives, formData.driveId]);

  // Track changes
  useEffect(() => {
    if (mode === 'create' && (formData.name || formData.steps.length > 0)) {
      setHasUnsavedChanges(true);
    } else if (mode === 'edit' && template) {
      const hasChanges =
        formData.name !== template.name ||
        formData.description !== (template.description || '') ||
        formData.category !== (template.category || '') ||
        formData.isPublic !== template.isPublic ||
        JSON.stringify(formData.tags) !== JSON.stringify(template.tags || []) ||
        JSON.stringify(formData.steps) !== JSON.stringify(template.steps);
      setHasUnsavedChanges(hasChanges);
    }
  }, [formData, template, mode]);

  // Warn before leaving with unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

  const validate = (): boolean => {
    const newErrors: FormErrors = {};

    if (!formData.name.trim()) {
      newErrors.name = 'Name is required';
    }

    if (!formData.driveId) {
      newErrors.driveId = 'Drive is required';
    }

    if (formData.steps.length === 0) {
      newErrors.steps = 'At least one step is required';
    }

    // Validate each step
    for (const step of formData.steps) {
      if (!step.agentId) {
        newErrors.steps = 'All steps must have an agent selected';
        break;
      }
      if (!step.promptTemplate.trim()) {
        newErrors.steps = 'All steps must have a prompt template';
        break;
      }
      if (step.requiresUserInput && !step.inputSchema) {
        newErrors.steps =
          'Steps requiring user input must have input fields defined';
        break;
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) {
      return;
    }

    setIsSaving(true);
    setSaveError(null);

    try {
      const payload = {
        name: formData.name,
        description: formData.description || null,
        driveId: formData.driveId,
        category: formData.category || null,
        tags: formData.tags.length > 0 ? formData.tags : null,
        isPublic: formData.isPublic,
        steps: formData.steps.map((step) => ({
          stepOrder: step.stepOrder,
          agentId: step.agentId,
          promptTemplate: step.promptTemplate,
          requiresUserInput: step.requiresUserInput,
          inputSchema: step.inputSchema,
          metadata: step.metadata,
        })),
      };

      const url =
        mode === 'create'
          ? '/api/workflows/templates'
          : `/api/workflows/templates/${templateId}`;
      const method = mode === 'create' ? 'POST' : 'PATCH';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to save workflow');
      }

      const result = await response.json();
      setHasUnsavedChanges(false);

      // Navigate to the template detail page
      router.push(`/workflows/templates/${result.id || templateId}`);
    } catch (error) {
      console.error('Failed to save workflow:', error);
      setSaveError(
        error instanceof Error ? error.message : 'Failed to save workflow'
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    if (
      hasUnsavedChanges &&
      !window.confirm(
        'You have unsaved changes. Are you sure you want to leave?'
      )
    ) {
      return;
    }
    router.back();
  };

  // Loading state
  if (mode === 'edit' && isLoadingTemplate) {
    return (
      <div className="container mx-auto py-8 px-4 max-w-7xl">
        <Skeleton className="h-8 w-64 mb-6" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Skeleton className="h-64" />
            <Skeleton className="h-96" />
          </div>
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 px-4 max-w-7xl">
      {/* Header */}
      <div className="mb-6">
        <Button variant="ghost" onClick={handleCancel} className="mb-4">
          <ArrowLeft className="size-4 mr-2" />
          Back to Workflows
        </Button>

        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">
              {mode === 'create' ? 'Create Workflow' : 'Edit Workflow'}
            </h1>
            <p className="text-muted-foreground mt-1">
              {mode === 'create'
                ? 'Define a new workflow template with sequential agent tasks'
                : 'Modify the workflow template configuration'}
            </p>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" onClick={handleCancel}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="size-4 mr-2" />
                  {mode === 'create' ? 'Create Workflow' : 'Save Changes'}
                </>
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Error alert */}
      {saveError && (
        <Alert variant="destructive" className="mb-6">
          <AlertCircle className="size-4" />
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}

      {/* Validation errors */}
      {Object.keys(errors).length > 0 && (
        <Alert variant="destructive" className="mb-6">
          <AlertCircle className="size-4" />
          <AlertDescription>
            Please fix the following errors:
            <ul className="list-disc list-inside mt-2">
              {errors.name && <li>{errors.name}</li>}
              {errors.driveId && <li>{errors.driveId}</li>}
              {errors.steps && <li>{errors.steps}</li>}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* Main content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: Metadata and Steps */}
        <div className="lg:col-span-2 space-y-6">
          <WorkflowMetadataForm
            name={formData.name}
            description={formData.description}
            driveId={formData.driveId}
            category={formData.category}
            tags={formData.tags}
            isPublic={formData.isPublic}
            drives={drives}
            onNameChange={(name) => setFormData({ ...formData, name })}
            onDescriptionChange={(description) =>
              setFormData({ ...formData, description })
            }
            onDriveIdChange={(driveId) =>
              setFormData({ ...formData, driveId })
            }
            onCategoryChange={(category) =>
              setFormData({ ...formData, category })
            }
            onTagsChange={(tags) => setFormData({ ...formData, tags })}
            onIsPublicChange={(isPublic) =>
              setFormData({ ...formData, isPublic })
            }
            errors={errors}
          />

          <WorkflowStepBuilder
            steps={formData.steps}
            onStepsChange={(steps) => setFormData({ ...formData, steps })}
            agents={agents}
          />
        </div>

        {/* Right column: Preview */}
        <div>
          <WorkflowPreview
            name={formData.name}
            description={formData.description}
            category={formData.category}
            tags={formData.tags}
            isPublic={formData.isPublic}
            steps={formData.steps}
            agents={agents}
          />
        </div>
      </div>

      {/* Bottom actions */}
      <div className="flex justify-end gap-2 mt-6 sticky bottom-4 bg-background/80 backdrop-blur-sm p-4 rounded-lg border">
        <Button variant="outline" onClick={handleCancel}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={isSaving}>
          {isSaving ? (
            <>
              <Loader2 className="size-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Save className="size-4 mr-2" />
              {mode === 'create' ? 'Create Workflow' : 'Save Changes'}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
