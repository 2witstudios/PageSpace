'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FileCode2, FileDown, FileSpreadsheet, FileText, Printer, Sheet } from 'lucide-react';
import { toast } from 'sonner';
import { PageType } from '@pagespace/lib/client-safe';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useMobile } from '@/hooks/useMobile';

type ExportFormat = 'docx' | 'csv' | 'xlsx' | 'markdown';

const EXPORT_FILE_EXTENSION: Record<ExportFormat, string> = {
  docx: 'docx',
  csv: 'csv',
  xlsx: 'xlsx',
  markdown: 'md',
};

const EXPORT_FORMAT_LABEL: Record<ExportFormat, string> = {
  docx: 'DOCX',
  csv: 'CSV',
  xlsx: 'Excel',
  markdown: 'Markdown',
};

interface ExportDropdownProps {
  pageId: string;
  pageTitle: string;
  pageType: PageType;
}

export function ExportDropdown({ pageId, pageTitle, pageType }: ExportDropdownProps) {
  const [isExporting, setIsExporting] = useState(false);
  const isMobile = useMobile();

  const handleExport = async (format: ExportFormat) => {
    const formatLabel = EXPORT_FORMAT_LABEL[format];
    const fileExtension = EXPORT_FILE_EXTENSION[format];

    setIsExporting(true);
    try {
      const response = await fetchWithAuth(`/api/pages/${pageId}/export/${format}`);

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || `Failed to export as ${formatLabel}`);
      }

      // Get the blob from the response
      const blob = await response.blob();

      // Create a download link
      const url = window.URL.createObjectURL(blob);
      const a = window.document.createElement('a');
      a.href = url;
      a.download = `${pageTitle}.${fileExtension}`;
      window.document.body.appendChild(a);
      a.click();

      // Cleanup
      window.URL.revokeObjectURL(url);
      window.document.body.removeChild(a);

      toast.success(`Exported as ${formatLabel}`, {
        description: `"${pageTitle}" has been downloaded`,
      });
    } catch (error) {
      console.error(`Error exporting as ${format}:`, error);
      toast.error(`Failed to export as ${formatLabel}`, {
        description: error instanceof Error ? error.message : 'An error occurred',
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const isDocument = pageType === 'DOCUMENT';
  const isSheet = pageType === 'SHEET';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size={isMobile ? "icon" : "sm"}
          disabled={isExporting}
        >
          <FileDown className={isMobile ? "h-4 w-4" : "mr-2 h-4 w-4"} />
          {!isMobile && (isExporting ? 'Exporting...' : 'Export')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {isDocument && (
          <>
            <DropdownMenuItem
              onClick={() => handleExport('docx')}
              disabled={isExporting}
            >
              <FileText className="mr-2 h-4 w-4" />
              Export as DOCX
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => handleExport('markdown')}
              disabled={isExporting}
            >
              <FileCode2 className="mr-2 h-4 w-4" />
              Export as Markdown
            </DropdownMenuItem>
          </>
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
