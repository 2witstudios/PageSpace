"use client";

import React, { useCallback } from 'react';
import { NodeViewWrapper, NodeViewContent, type NodeViewProps } from '@tiptap/react';

const LANGUAGES = [
  { value: '', label: 'Plain text' },
  { value: 'sudolang', label: 'SudoLang' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'json', label: 'JSON' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'bash', label: 'Bash' },
  { value: 'sql', label: 'SQL' },
  { value: 'rust', label: 'Rust' },
  { value: 'go', label: 'Go' },
  { value: 'yaml', label: 'YAML' },
] as const;

export function LanguageSelector({ node, updateAttributes }: NodeViewProps) {
  const currentLanguage = node.attrs.language || '';

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      updateAttributes({ language: e.target.value || null });
    },
    [updateAttributes]
  );

  return (
    <NodeViewWrapper as="pre" className={node.attrs.language ? `language-${node.attrs.language}` : ''}>
      <select
        contentEditable={false}
        value={currentLanguage}
        onChange={handleChange}
        className="absolute top-1 right-1 z-10 rounded border border-border bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground outline-none hover:bg-muted focus:ring-1 focus:ring-ring"
        aria-label="Select language"
      >
        {LANGUAGES.map((lang) => (
          <option key={lang.value} value={lang.value}>
            {lang.label}
          </option>
        ))}
      </select>
      <NodeViewContent<"code"> as="code" className={node.attrs.language ? `language-${node.attrs.language}` : ''} />
    </NodeViewWrapper>
  );
}
