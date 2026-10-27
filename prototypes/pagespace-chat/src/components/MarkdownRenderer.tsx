'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useState } from 'react';

interface Props {
  content: string;
  isStreaming?: boolean;
}

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={copy}
      className="absolute top-2 right-2 px-2 py-1 text-xs rounded bg-white/10 hover:bg-white/20 text-gray-300 transition-colors"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

export default function MarkdownRenderer({ content, isStreaming }: Props) {
  return (
    <div className={`prose prose-invert prose-sm max-w-none${isStreaming ? ' streaming-cursor' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className ?? '');
            const codeStr = String(children).replace(/\n$/, '');
            if (match) {
              return (
                <div className="relative rounded-lg overflow-hidden my-3 border border-white/10">
                  <div className="flex items-center justify-between px-4 py-1.5 bg-white/5 border-b border-white/10">
                    <span className="text-xs text-gray-400 font-mono">{match[1]}</span>
                    <CopyButton code={codeStr} />
                  </div>
                  <SyntaxHighlighter
                    style={oneDark}
                    language={match[1]}
                    PreTag="div"
                    customStyle={{
                      margin: 0,
                      padding: '1rem',
                      background: '#13131a',
                      fontSize: '0.8125rem',
                      lineHeight: '1.6',
                    }}
                    codeTagProps={{ style: { fontFamily: 'ui-monospace, monospace' } }}
                  >
                    {codeStr}
                  </SyntaxHighlighter>
                </div>
              );
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          pre({ children }) {
            return <>{children}</>;
          },
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline underline-offset-2">
                {children}
              </a>
            );
          },
          table({ children }) {
            return (
              <div className="overflow-x-auto my-4">
                <table className="w-full text-sm border-collapse">{children}</table>
              </div>
            );
          },
          th({ children }) {
            return <th className="px-3 py-2 text-left text-xs font-semibold text-gray-400 uppercase tracking-wide border-b border-white/10">{children}</th>;
          },
          td({ children }) {
            return <td className="px-3 py-2 border-b border-white/5 text-gray-300">{children}</td>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
