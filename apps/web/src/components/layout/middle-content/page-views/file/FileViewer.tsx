'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Download, FileIcon, FileText, Image as ImageIcon, Code, FileSpreadsheet } from 'lucide-react';
import { formatBytes } from '@/lib/utils';
import { TreePage } from '@/hooks/usePageTree';

// Import specialized viewers
import PDFViewer from './viewers/PDFViewer';
import ImageViewer from './viewers/ImageViewer';
import CodeViewer from './viewers/CodeViewer';
import GenericFileViewer from './viewers/GenericFileViewer';

interface FileViewerProps {
  page: TreePage;
}

// Helper function to determine file type from mime type
function getFileType(mimeType: string | undefined, fileName: string | undefined): string {
  if (!mimeType) return 'generic';
  
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('text/') || isCodeFile(fileName)) return 'code';
  if (isOfficeDocument(mimeType)) return 'office';
  
  return 'generic';
}

// Check if file is a code file based on extension
function isCodeFile(fileName: string | undefined): boolean {
  if (!fileName) return false;
  const codeExtensions = [
    '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cpp', '.cs',
    '.rb', '.go', '.rs', '.php', '.swift', '.kt', '.scala', '.r',
    '.html', '.css', '.scss', '.sass', '.less', '.json', '.xml', '.yaml', '.yml',
    '.md', '.markdown', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat',
    '.sql', '.graphql', '.gql', '.vue', '.svelte'
  ];
  return codeExtensions.some(ext => fileName.toLowerCase().endsWith(ext));
}

// Check if file is an office document
function isOfficeDocument(mimeType: string): boolean {
  const officeTypes = [
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ];
  return officeTypes.includes(mimeType);
}

// Get appropriate icon for file type
function getFileIcon(fileType: string) {
  switch (fileType) {
    case 'image':
      return <ImageIcon className="h-5 w-5" aria-hidden="true" />;
    case 'pdf':
      return <FileText className="h-5 w-5" aria-hidden="true" />;
    case 'code':
      return <Code className="h-5 w-5" aria-hidden="true" />;
    case 'office':
      return <FileSpreadsheet className="h-5 w-5" aria-hidden="true" />;
    default:
      return <FileIcon className="h-5 w-5" aria-hidden="true" />;
  }
}

export default function FileViewer({ page }: FileViewerProps) {
  const [isLoading, setIsLoading] = useState(false);
  const fileType = getFileType(page.mimeType, page.originalFileName);

  // Handle file download
  const handleDownload = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/files/${page.id}/download`);
      if (!response.ok) {
        throw new Error('Failed to download file');
      }
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = page.originalFileName || page.title;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Download error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Render appropriate viewer based on file type
  const renderViewer = () => {
    switch (fileType) {
      case 'pdf':
        return <PDFViewer page={page} />;
      case 'image':
        return <ImageViewer page={page} />;
      case 'code':
        return <CodeViewer page={page} />;
      default:
        return <GenericFileViewer page={page} />;
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* File info header */}
      <div className="flex items-center justify-between p-4 border-b">
        <div className="flex items-center gap-3">
          {getFileIcon(fileType)}
          <div>
            <h2 className="text-lg font-semibold">{page.title}</h2>
            <p className="text-sm text-muted-foreground">
              {page.originalFileName && page.originalFileName !== page.title && (
                <span>{page.originalFileName} • </span>
              )}
              {page.fileSize && formatBytes(page.fileSize)}
              {page.mimeType && <span> • {page.mimeType}</span>}
            </p>
          </div>
        </div>
        <Button
          onClick={handleDownload}
          disabled={isLoading}
          variant="outline"
        >
          <Download className="mr-2 h-4 w-4" />
          {isLoading ? 'Downloading...' : 'Download'}
        </Button>
      </div>

      {/* File viewer */}
      <div className="flex-1 overflow-auto">
        {renderViewer()}
      </div>
    </div>
  );
}