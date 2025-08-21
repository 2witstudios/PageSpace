import React, { useEffect } from 'react';
import Editor from '@monaco-editor/react';

interface MonacoEditorProps {
  value: string;
  onChange: (value: string | undefined) => void;
  readOnly?: boolean;
  language?: string;
}

const MonacoEditor = ({ value, onChange, readOnly, language = 'markdown' }: MonacoEditorProps) => {
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.MonacoEnvironment = {
        getWorkerUrl: (_moduleId: string, label: string) => {
          if (label === 'json') return '/_next/static/json.worker.js';
          if (label === 'css') return '/_next/static/css.worker.js';
          if (label === 'html') return '/_next/static/html.worker.js';
          if (label === 'typescript' || label === 'javascript')
            return '/_next/static/ts.worker.js';
          return '/_next/static/editor.worker.js';
        },
      };
    }
  }, []);

  return (
    <Editor
      height="100%"
      language={language}
      value={value}
      onChange={onChange}
      options={{
        readOnly,
        domReadOnly: readOnly,
        cursorWidth: readOnly ? 0 : undefined,
        contextmenu: true, // Allow context menu even in read-only for copying
        columnSelection: true, // Allow column selection for copying
        dragAndDrop: !readOnly,
        hover: readOnly ? { enabled: true } : undefined, // Keep hover for tooltips
        readOnlyMessage: readOnly ? { value: "" } : undefined,
        selectOnLineNumbers: true, // Allow line selection
        copyWithSyntaxHighlighting: true, // Better copy experience
        minimap: { enabled: true },
        wordWrap: 'on',
        scrollBeyondLastLine: false,
        fontSize: 16,
        lineNumbers: 'on',
        glyphMargin: true,
        folding: true,
        lineDecorationsWidth: 10,
        lineNumbersMinChars: 3,
        renderLineHighlight: readOnly ? 'none' : 'line',
        scrollbar: {
          vertical: 'auto',
          horizontal: 'auto'
        },
      }}
    />
  );
};

export default MonacoEditor;