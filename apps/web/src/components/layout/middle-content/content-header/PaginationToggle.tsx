'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { FileText } from 'lucide-react';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface PaginationToggleProps {
  pageId: string;
  initialIsPaginated: boolean;
  onToggle: (isPaginated: boolean) => void;
}

export function PaginationToggle({ pageId, initialIsPaginated, onToggle }: PaginationToggleProps) {
  const [isPaginated, setIsPaginated] = useState(initialIsPaginated);
  const [isUpdating, setIsUpdating] = useState(false);

  useEffect(() => {
    setIsPaginated(initialIsPaginated);
  }, [initialIsPaginated]);

  const handleToggle = async (newValue: boolean) => {
    setIsUpdating(true);
    try {
      const response = await fetchWithAuth(`/api/pages/${pageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPaginated: newValue }),
      });

      if (!response.ok) {
        throw new Error('Failed to update pagination setting');
      }

      setIsPaginated(newValue);
      onToggle(newValue);

      toast.success(
        newValue ? 'Pagination enabled' : 'Pagination disabled',
        {
          description: newValue
            ? 'Document will display with page breaks and page numbers'
            : 'Document will display as continuous content',
          duration: 3000,
        }
      );

      // Reload page to apply changes to editor
      window.location.reload();
    } catch (error) {
      console.error('Failed to toggle pagination:', error);
      toast.error('Failed to update pagination setting');
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={isUpdating}
          className="h-8"
        >
          <FileText className="h-4 w-4 mr-2" />
          Page Layout
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Document Layout</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => handleToggle(false)}
          className={!isPaginated ? 'bg-accent' : ''}
        >
          <div className="flex flex-col">
            <span className="font-medium">Continuous</span>
            <span className="text-xs text-muted-foreground">
              Single scrolling document
            </span>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => handleToggle(true)}
          className={isPaginated ? 'bg-accent' : ''}
        >
          <div className="flex flex-col">
            <span className="font-medium">Paginated (US Letter)</span>
            <span className="text-xs text-muted-foreground">
              Pages with breaks, headers & footers
            </span>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
