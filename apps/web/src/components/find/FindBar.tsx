"use client";

import React, { useEffect, useRef } from 'react';
import { Search, X, ChevronUp, ChevronDown } from 'lucide-react';
import { useFindStore } from '@/stores/useFindStore';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export function FindBar() {
  const { isOpen, query, currentIndex, totalMatches, close, setQuery, next, prev } =
    useFindStore();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) prev();
      else next();
    } else if (e.key === 'F3') {
      e.preventDefault();
      if (e.shiftKey) prev();
      else next();
    }
  };

  const matchLabel = query
    ? totalMatches === 0
      ? 'No results'
      : `${currentIndex + 1} of ${totalMatches}`
    : '';

  return (
    <div className="absolute top-2 right-4 z-20 flex items-center gap-1 rounded-lg border bg-background shadow-lg px-2 py-1.5">
      <Search className="h-4 w-4 text-muted-foreground shrink-0" />
      <Input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find..."
        className="h-7 w-44 border-0 shadow-none focus-visible:ring-0 px-1 text-sm"
      />
      <span className="text-xs text-muted-foreground whitespace-nowrap w-16 text-center">
        {matchLabel}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={prev}
        disabled={totalMatches === 0}
        aria-label="Previous match"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={next}
        disabled={totalMatches === 0}
        aria-label="Next match"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={close}
        aria-label="Close find bar"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
