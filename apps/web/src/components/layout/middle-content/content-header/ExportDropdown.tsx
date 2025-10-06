'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FileDown, FileText, Printer } from 'lucide-react';
import { toast } from 'sonner';

interface ExportDropdownProps {
  pageId: string;
  pageTitle: string;
}

export function ExportDropdown({ pageId, pageTitle }: ExportDropdownProps) {
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async (format: 'docx') => {
    setIsExporting(true);
    try {
      const response = await fetch(`/api/pages/${pageId}/export/${format}`);

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || `Failed to export as ${format.toUpperCase()}`);
      }

      // Get the blob from the response
      const blob = await response.blob();

      // Create a download link
      const url = window.URL.createObjectURL(blob);
      const a = window.document.createElement('a');
      a.href = url;
      a.download = `${pageTitle}.${format}`;
      window.document.body.appendChild(a);
      a.click();

      // Cleanup
      window.URL.revokeObjectURL(url);
      window.document.body.removeChild(a);

      toast.success(`Exported as ${format.toUpperCase()}`, {
        description: `"${pageTitle}" has been downloaded`,
      });
    } catch (error) {
      console.error(`Error exporting as ${format}:`, error);
      toast.error(`Failed to export as ${format.toUpperCase()}`, {
        description: error instanceof Error ? error.message : 'An error occurred',
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={isExporting}
        >
          <FileDown className="mr-2 h-4 w-4" />
          {isExporting ? 'Exporting...' : 'Export'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => handleExport('docx')}
          disabled={isExporting}
        >
          <FileText className="mr-2 h-4 w-4" />
          Export as DOCX
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handlePrint}>
          <Printer className="mr-2 h-4 w-4" />
          Print
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
