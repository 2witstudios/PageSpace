'use client';

// Ported from apps/web/src/components/find/FindBar.tsx (not vendored before IMC-9.10). The
// labels match web's; the bar lays out as the 44px strip under the page head instead of
// floating over the top-right corner. It stays bound to the vendored useFindStore.

import React, { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useFindStore } from '@/retained/stores/useFindStore';
import { Input } from '@/retained/components/ui/input';
import { Button } from '@/retained/components/ui/button';

export function FindBar() {
  const { isOpen, query, currentIndex, totalMatches, close, setQuery, next, prev } = useFindStore();
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
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <Input
        ref={inputRef}
        aria-label="Find"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find..."
        data-find-field=""
        className="h-7 w-56 border-0 px-1 text-sm shadow-none focus-visible:ring-0"
      />
      <span className="w-16 whitespace-nowrap text-center text-xs text-muted-foreground">{matchLabel}</span>
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
      <span className="whitespace-nowrap text-xs text-muted-foreground">Enter next · Esc close</span>
      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={close} aria-label="Close find bar">
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
