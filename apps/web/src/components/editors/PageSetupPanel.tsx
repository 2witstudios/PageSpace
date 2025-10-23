"use client";

import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';

interface PageSetupPanelProps {
  pageId: string;
  // Visual only props for now - no backend wiring
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function PageSetupPanel({ pageId }: PageSetupPanelProps) {
  // pageId will be used when wiring up backend functionality
  return (
    <div className="flex items-center gap-4 p-2 border-b border-[var(--separator)]">
      {/* Page Size Dropdown */}
      <div className="flex items-center gap-2">
        <label className="text-sm text-muted-foreground whitespace-nowrap">Size:</label>
        <Select defaultValue="letter" disabled>
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
        <Select defaultValue="normal" disabled>
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
        <Checkbox id="pageNumbers" defaultChecked disabled />
        <label htmlFor="pageNumbers" className="text-sm cursor-pointer">
          Page numbers
        </label>
      </div>

      {/* Headers Checkbox */}
      <div className="flex items-center gap-2">
        <Checkbox id="headers" disabled />
        <label htmlFor="headers" className="text-sm cursor-pointer">
          Headers
        </label>
      </div>

      {/* Footers Checkbox */}
      <div className="flex items-center gap-2">
        <Checkbox id="footers" disabled />
        <label htmlFor="footers" className="text-sm cursor-pointer">
          Footers
        </label>
      </div>
    </div>
  );
}
