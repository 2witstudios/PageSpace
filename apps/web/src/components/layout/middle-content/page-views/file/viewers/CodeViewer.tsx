'use client';

import { useState, useEffect } from 'react';
import { TreePage } from '@/hooks/usePageTree';
import { Loader2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

// Dynamically import Monaco to avoid SSR issues
const MonacoEditor = dynamic(
  () => import('@monaco-editor/react'),
  { 
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }
);

interface CodeViewerProps {
  page: TreePage;
}

// Map file extensions to Monaco language IDs
function getLanguageFromFileName(fileName: string | undefined): string {
  if (!fileName) return 'plaintext';
  
  const ext = fileName.toLowerCase().split('.').pop();
  const languageMap: Record<string, string> = {
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'py': 'python',
    'java': 'java',
    'c': 'c',
    'cpp': 'cpp',
    'cs': 'csharp',
    'rb': 'ruby',
    'go': 'go',
    'rs': 'rust',
    'php': 'php',
    'swift': 'swift',
    'kt': 'kotlin',
    'scala': 'scala',
    'r': 'r',
    'html': 'html',
    'css': 'css',
    'scss': 'scss',
    'sass': 'sass',
    'less': 'less',
    'json': 'json',
    'xml': 'xml',
    'yaml': 'yaml',
    'yml': 'yaml',
    'md': 'markdown',
    'markdown': 'markdown',
    'sh': 'shell',
    'bash': 'shell',
    'zsh': 'shell',
    'fish': 'shell',
    'ps1': 'powershell',
    'bat': 'bat',
    'sql': 'sql',
    'graphql': 'graphql',
    'gql': 'graphql',
    'vue': 'vue',
    'svelte': 'svelte',
  };
  
  return languageMap[ext || ''] || 'plaintext';
}

export default function CodeViewer({ page }: CodeViewerProps) {
  const [code, setCode] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadCode = async () => {
      try {
        setIsLoading(true);
        const response = await fetchWithAuth(`/api/files/${page.id}/download`);
        if (!response.ok) {
          throw new Error('Failed to load file');
        }

        const text = await response.text();
        setCode(text);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load file');
      } finally {
        setIsLoading(false);
      }
    };

    loadCode();
  }, [page.id]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">Error: {error}</p>
      </div>
    );
  }

  const language = getLanguageFromFileName(page.originalFileName || page.title);

  return (
    <div className="h-full">
      <MonacoEditor
        value={code}
        language={language}
        theme="vs-dark"
        options={{
          readOnly: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 14,
          wordWrap: 'on',
          lineNumbers: 'on',
          renderWhitespace: 'selection',
          cursorStyle: 'line',
          automaticLayout: true,
        }}
      />
    </div>
  );
}