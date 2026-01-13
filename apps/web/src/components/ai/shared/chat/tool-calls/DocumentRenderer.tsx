import React, { memo } from 'react';
import { FileCode } from 'lucide-react';
import { CodeBlock, CodeBlockCopyButton } from '@/components/ai/ui/code-block';
import { cn } from '@/lib/utils';
import { type BundledLanguage } from 'shiki';

interface DocumentRendererProps {
    title: string;
    content: string;
    language?: string;
    description?: string;
    className?: string;
}

export const DocumentRenderer: React.FC<DocumentRendererProps> = memo(function DocumentRenderer({
    title,
    content,
    language = 'typescript',
    description,
    className
}) {
    // Default to typescript if language is not provided or valid
    // In a real app we might want to validate against BundledLanguage or map extensions
    const safeLanguage = (language || 'typescript') as BundledLanguage;

    return (
        <div className={cn("rounded-md border bg-card overflow-hidden my-2", className)}>
            <div className="flex items-center justify-between px-3 py-2 bg-muted/40 border-b">
                <div className="flex items-center gap-2 overflow-hidden">
                    <FileCode className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-sm font-medium truncate" title={title}>{title}</span>
                </div>
                {description && (
                    <span className="text-xs text-muted-foreground hidden sm:inline-block truncate max-w-[200px]">{description}</span>
                )}
            </div>
            <div className="relative">
                <CodeBlock
                    code={content}
                    language={safeLanguage}
                    showLineNumbers={true}
                    className="border-0 rounded-none bg-background"
                >
                    <CodeBlockCopyButton />
                </CodeBlock>
            </div>
        </div>
    );
});
