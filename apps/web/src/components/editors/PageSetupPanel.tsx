"use client";

import React, { useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { fetchWithAuth } from '@/lib/auth-fetch';

interface PageSetupPanelProps {
  pageId: string;
  pageSize: string;
  margins: string;
  showPageNumbers: boolean;
  showHeaders: boolean;
  showFooters: boolean;
  onSettingChange?: (field: string, value: string | boolean) => void;
}

export function PageSetupPanel({
  pageId,
  pageSize,
  margins,
  showPageNumbers,
  showHeaders,
  showFooters,
  onSettingChange
}: PageSetupPanelProps) {
  const [isUpdating, setIsUpdating] = useState(false);

  const updateSetting = async (field: string, value: string | boolean) => {
    setIsUpdating(true);
    try {
      await fetchWithAuth(`/api/pages/${pageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });

      // Notify parent component of the change
      if (onSettingChange) {
        onSettingChange(field, value);
      }
    } catch (error) {
      console.error(`Failed to update ${field}:`, error);
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <div className="flex items-center gap-4 p-2 border-b border-[var(--separator)]">
      {/* Page Size Dropdown */}
      <div className="flex items-center gap-2">
        <label className="text-sm text-muted-foreground whitespace-nowrap">Size:</label>
        <Select
          value={pageSize}
          onValueChange={(value) => updateSetting('pageSize', value)}
          disabled={isUpdating}
        >
          <SelectTrigger className="w-40 h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="letter">US Letter (8.5&quot; × 11&quot;)</SelectItem>
            <SelectItem value="a4">A4 (210mm × 297mm)</SelectItem>
            <SelectItem value="legal">Legal (8.5&quot; × 14&quot;)</SelectItem>
            <SelectItem value="a3">A3 (297mm × 420mm)</SelectItem>
            <SelectItem value="tabloid">Tabloid (11&quot; × 17&quot;)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Margins Dropdown */}
      <div className="flex items-center gap-2">
        <label className="text-sm text-muted-foreground whitespace-nowrap">Margins:</label>
        <Select
          value={margins}
          onValueChange={(value) => updateSetting('margins', value)}
          disabled={isUpdating}
        >
          <SelectTrigger className="w-32 h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="normal">Normal (1&quot;)</SelectItem>
            <SelectItem value="narrow">Narrow (0.5&quot;)</SelectItem>
            <SelectItem value="wide">Wide (2&quot;)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Separator */}
      <div className="w-[1px] h-6 bg-border" />

      {/* Page Numbers Checkbox */}
      <div className="flex items-center gap-2">
        <Checkbox
          id="pageNumbers"
          checked={showPageNumbers}
          onCheckedChange={(checked) => updateSetting('showPageNumbers', checked === true)}
          disabled={isUpdating}
        />
        <label htmlFor="pageNumbers" className="text-sm cursor-pointer">
          Page numbers
        </label>
      </div>

      {/* Headers Checkbox */}
      <div className="flex items-center gap-2">
        <Checkbox
          id="headers"
          checked={showHeaders}
          onCheckedChange={(checked) => updateSetting('showHeaders', checked === true)}
          disabled={isUpdating}
        />
        <label htmlFor="headers" className="text-sm cursor-pointer">
          Headers
        </label>
      </div>

      {/* Footers Checkbox */}
      <div className="flex items-center gap-2">
        <Checkbox
          id="footers"
          checked={showFooters}
          onCheckedChange={(checked) => updateSetting('showFooters', checked === true)}
          disabled={isUpdating}
        />
        <label htmlFor="footers" className="text-sm cursor-pointer">
          Footers
        </label>
      </div>
    </div>
  );
}
