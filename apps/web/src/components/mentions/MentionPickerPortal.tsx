'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { MentionPickerPanel, TAB_TYPES, type TabType } from './MentionPicker';
import type { MentionSuggestion, MentionType } from '@/types/mentions';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { Position } from '@/services/positioningService';

export interface MentionPickerPortalProps {
  isOpen: boolean;
  position: Position | null;
  driveId?: string;
  crossDrive?: boolean;
  allowedTypes?: MentionType[];
  /** Pre-fills the search input with what was typed after @ */
  initialQuery?: string;
  onSelect: (suggestion: MentionSuggestion) => void;
  onClose: () => void;
}

export function MentionPickerPortal({
  isOpen,
  position,
  driveId,
  crossDrive = false,
  allowedTypes = ['page', 'user', 'everyone', 'role'],
  initialQuery = '',
  onSelect,
  onClose,
}: MentionPickerPortalProps) {
  const [query, setQuery] = useState(initialQuery);
  const [activeTab, setActiveTab] = useState<TabType>('all');
  const [items, setItems] = useState<MentionSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Sync initialQuery when popup opens; capture element to return focus to on close
  useEffect(() => {
    if (isOpen) {
      returnFocusRef.current = document.activeElement as HTMLElement;
      setQuery(initialQuery);
      setActiveTab('all');
      setSelectedIndex(0);
    } else {
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    }
  }, [isOpen, initialQuery]);

  const allowedTypesKey = allowedTypes.join(',');

  const fetchSuggestions = useCallback(
    async (q: string, tab: TabType) => {
      if (!driveId && !crossDrive) return;
      setLoading(true);
      const currentAllowed = allowedTypesKey.split(',') as MentionType[];
      const types = TAB_TYPES[tab]
        .filter((t) => currentAllowed.includes(t))
        .join(',');
      const base = driveId
        ? `/api/mentions/search?q=${encodeURIComponent(q)}&driveId=${encodeURIComponent(driveId)}&types=${types}`
        : `/api/mentions/search?q=${encodeURIComponent(q)}&types=${types}`;
      const url = crossDrive ? `${base}&crossDrive=true` : base;
      try {
        const response = await fetchWithAuth(url);
        const data: MentionSuggestion[] = await response.json();
        setItems(data);
        setSelectedIndex(0);
      } catch {
        setItems([]);
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [driveId, crossDrive, allowedTypesKey],
  );

  useEffect(() => {
    if (!isOpen) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void fetchSuggestions(query, activeTab);
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, activeTab, fetchSuggestions, isOpen]);

  // Close on Escape via document keydown (portal is outside component tree)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [isOpen, onClose]);

  if (!isOpen || !position) return null;
  if (typeof document === 'undefined') return null;

  const style: React.CSSProperties = {
    position: 'fixed',
    zIndex: 50,
    ...(position.bottom !== undefined
      ? { bottom: position.bottom, left: position.left }
      : { top: position.top, left: position.left }),
    ...(position.width ? { width: position.width } : {}),
  };

  return createPortal(
    <div
      style={style}
      className="bg-popover border border-border rounded-md shadow-md overflow-hidden"
    >
      <MentionPickerPanel
        items={items}
        loading={loading}
        query={query}
        onQueryChange={setQuery}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        selectedIndex={selectedIndex}
        onSelect={(s) => {
          onSelect(s);
          onClose();
        }}
        onSelectionChange={setSelectedIndex}
        allowedTypes={allowedTypes}
      />
    </div>,
    document.body,
  );
}

export default MentionPickerPortal;
