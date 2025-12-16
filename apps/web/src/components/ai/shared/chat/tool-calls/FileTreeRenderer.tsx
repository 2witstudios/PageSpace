import React from 'react';
import { PageType, isFolderPage } from '@pagespace/lib/client-safe';
import { FolderOpen, FileText } from 'lucide-react';

interface TreeItem {
    path: string;
    title: string;
    type: string;
    children: TreeItem[];
}

interface FileTreeRendererProps {
    tree: TreeItem[];
}

export const FileTreeRenderer: React.FC<FileTreeRendererProps> = ({ tree }) => {
    const renderTreeItems = (items: TreeItem[], depth = 0): React.ReactNode => {
        return items.map((item, index) => (
            <div key={index} style={{ paddingLeft: `${depth * 16}px` }} className="py-1">
                <div className="flex items-center gap-2 text-sm">
                    {isFolderPage(item.type as PageType) ? (
                        <FolderOpen className="h-4 w-4 text-primary opacity-80" />
                    ) : (
                        <FileText className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className="text-foreground/90">{item.title}</span>
                </div>
                {item.children?.length > 0 && renderTreeItems(item.children, depth + 1)}
            </div>
        ));
    };

    return (
        <div className="rounded-md border bg-card p-4">
            <div className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Structure
            </div>
            <div className="space-y-0.5">
                {renderTreeItems(tree)}
            </div>
        </div>
    );
};
