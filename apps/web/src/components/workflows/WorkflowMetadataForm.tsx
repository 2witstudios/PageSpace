'use client';

import React from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { X } from 'lucide-react';

const WORKFLOW_CATEGORIES = [
  'Content Generation',
  'Data Analysis',
  'Research',
  'Documentation',
  'Code Review',
  'Project Planning',
  'Customer Support',
  'Training',
  'Quality Assurance',
  'Other',
];

interface WorkflowMetadataFormProps {
  name: string;
  description: string;
  driveId: string;
  category: string;
  tags: string[];
  isPublic: boolean;
  drives: Array<{ id: string; name: string }>;
  onNameChange: (name: string) => void;
  onDescriptionChange: (description: string) => void;
  onDriveIdChange: (driveId: string) => void;
  onCategoryChange: (category: string) => void;
  onTagsChange: (tags: string[]) => void;
  onIsPublicChange: (isPublic: boolean) => void;
  errors?: {
    name?: string;
    driveId?: string;
  };
}

export function WorkflowMetadataForm({
  name,
  description,
  driveId,
  category,
  tags,
  isPublic,
  drives,
  onNameChange,
  onDescriptionChange,
  onDriveIdChange,
  onCategoryChange,
  onTagsChange,
  onIsPublicChange,
  errors = {},
}: WorkflowMetadataFormProps) {
  const [tagInput, setTagInput] = React.useState('');

  const addTag = (tag: string) => {
    const trimmedTag = tag.trim();
    if (trimmedTag && !tags.includes(trimmedTag)) {
      onTagsChange([...tags, trimmedTag]);
    }
    setTagInput('');
  };

  const removeTag = (tagToRemove: string) => {
    onTagsChange(tags.filter((t) => t !== tagToRemove));
  };

  const handleTagInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTag(tagInput);
    } else if (e.key === ',' && tagInput.trim()) {
      e.preventDefault();
      addTag(tagInput);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workflow Information</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Name */}
        <div>
          <Label htmlFor="workflow-name">
            Name <span className="text-destructive">*</span>
          </Label>
          <Input
            id="workflow-name"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="e.g., Blog Post Creation Workflow"
            className={errors.name ? 'border-destructive' : ''}
          />
          {errors.name && (
            <p className="text-sm text-destructive mt-1">{errors.name}</p>
          )}
        </div>

        {/* Description */}
        <div>
          <Label htmlFor="workflow-description">Description</Label>
          <Textarea
            id="workflow-description"
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder="Describe what this workflow does and when to use it..."
            rows={3}
          />
        </div>

        {/* Drive Selection */}
        <div>
          <Label htmlFor="workflow-drive">
            Drive <span className="text-destructive">*</span>
          </Label>
          <Select value={driveId} onValueChange={onDriveIdChange}>
            <SelectTrigger
              id="workflow-drive"
              className={errors.driveId ? 'border-destructive' : ''}
            >
              <SelectValue placeholder="Select a drive..." />
            </SelectTrigger>
            <SelectContent>
              {drives.length === 0 ? (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">
                  No drives available
                </div>
              ) : (
                drives.map((drive) => (
                  <SelectItem key={drive.id} value={drive.id}>
                    {drive.name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          {errors.driveId && (
            <p className="text-sm text-destructive mt-1">{errors.driveId}</p>
          )}
        </div>

        {/* Category */}
        <div>
          <Label htmlFor="workflow-category">Category</Label>
          <Select value={category} onValueChange={onCategoryChange}>
            <SelectTrigger id="workflow-category">
              <SelectValue placeholder="Select a category..." />
            </SelectTrigger>
            <SelectContent>
              {WORKFLOW_CATEGORIES.map((cat) => (
                <SelectItem key={cat} value={cat}>
                  {cat}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Tags */}
        <div>
          <Label htmlFor="workflow-tags">Tags</Label>
          <Input
            id="workflow-tags"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={handleTagInputKeyDown}
            onBlur={() => {
              if (tagInput.trim()) {
                addTag(tagInput);
              }
            }}
            placeholder="Type a tag and press Enter or comma..."
          />
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="gap-1">
                  {tag}
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    className="ml-1 hover:text-destructive"
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </div>

        {/* Public toggle */}
        <div className="flex items-center space-x-2">
          <Checkbox
            id="workflow-public"
            checked={isPublic}
            onCheckedChange={(checked) => onIsPublicChange(checked === true)}
          />
          <div className="space-y-0.5">
            <Label htmlFor="workflow-public" className="font-normal">
              Make this workflow public
            </Label>
            <p className="text-xs text-muted-foreground">
              Public workflows can be used by anyone in the workspace
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
