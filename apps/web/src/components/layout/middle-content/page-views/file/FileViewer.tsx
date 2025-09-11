'use client';

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


export default function FileViewer({ page }: FileViewerProps) {
  const fileType = getFileType(page.mimeType, page.originalFileName);

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

  return renderViewer();
}