'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FileDown, FileText, FileSpreadsheet, Sheet, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { PageType } from '@pagespace/lib/client-safe';
import { fetchWithAuth } from '@/lib/auth-fetch';
import { printPaginatedDocument } from '@/lib/editor/pagination';

type ExportFormat = 'docx' | 'csv' | 'xlsx';

interface ExportDropdownProps {
  pageId: string;
  pageTitle: string;
  pageType: PageType;
  editorElement?: HTMLElement | null;
  isPaginated?: boolean;
}

export function ExportDropdown({
  pageId,
  pageTitle,
  pageType,
  editorElement,
  isPaginated = false
}: ExportDropdownProps) {
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async (format: ExportFormat) => {
    setIsExporting(true);
    try {
      const response = await fetchWithAuth(`/api/pages/${pageId}/export/${format}`);

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

  const handlePrint = async () => {
    // Use pagination-aware print handler if document is paginated and editor is available
    if (isPaginated && editorElement) {
      try {
        await printPaginatedDocument(editorElement);
      } catch (error) {
        console.error('Error printing paginated document:', error);
        toast.error('Print failed', {
          description: 'Could not prepare document for printing',
        });
      }
    } else {
      // Fall back to standard browser print
      window.print();
    }
  };

  const isDocument = pageType === 'DOCUMENT';
  const isSheet = pageType === 'SHEET';

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
        {isDocument && (
          <DropdownMenuItem
            onClick={() => handleExport('docx')}
            disabled={isExporting}
          >
            <FileText className="mr-2 h-4 w-4" />
            Export as DOCX
          </DropdownMenuItem>
        )}
        {isSheet && (
          <>
            <DropdownMenuItem
              onClick={() => handleExport('csv')}
              disabled={isExporting}
            >
              <FileSpreadsheet className="mr-2 h-4 w-4" />
              Export as CSV
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => handleExport('xlsx')}
              disabled={isExporting}
            >
              <Sheet className="mr-2 h-4 w-4" />
              Export as Excel
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem onClick={handlePrint}>
          <Printer className="mr-2 h-4 w-4" />
          Print
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
