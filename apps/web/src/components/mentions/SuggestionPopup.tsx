"use client";

import React, { useEffect, useRef } from 'react';
import { MentionSuggestion } from '@/types/mentions';
import { Position } from '@/services/positioningService';

export interface SuggestionPopupProps {
  isOpen: boolean;
  items: MentionSuggestion[];
  selectedIndex: number;
  position: Position | null;
  loading?: boolean;
  error?: string | null;
  onSelect: (suggestion: MentionSuggestion) => void;
  onSelectionChange: (index: number) => void;
  className?: string;
  variant?: 'overlay' | 'inline';
  popupPlacement?: 'top' | 'bottom';
}

export default function SuggestionPopup({
  isOpen,
  items,
  selectedIndex,
  position,
  loading = false,
  error = null,
  onSelect,
  onSelectionChange,
  className,
  variant = 'overlay',
  popupPlacement = 'bottom',
}: SuggestionPopupProps) {
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);

  // Auto-scroll selected item into view
  useEffect(() => {
    if (itemRefs.current[selectedIndex]) {
      itemRefs.current[selectedIndex]?.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      });
    }
  }, [selectedIndex]);

  // Reset refs when items change
  useEffect(() => {
    itemRefs.current = itemRefs.current.slice(0, items.length);
  }, [items.length]);

  if (!isOpen || !position) {
    return null;
  }

  const renderContent = () => {
    if (loading) {
      return (
        <div className="p-3 text-sm text-gray-500 flex items-center gap-2">
          <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-gray-500"></div>
          Loading suggestions...
        </div>
      );
    }

    if (error) {
      return (
        <div className="p-3 text-sm text-red-500">
          {error}
        </div>
      );
    }

    if (items.length === 0) {
      return (
        <div className="p-3 text-sm text-gray-500">
          No results found
        </div>
      );
    }

    return (
      <ul
        className={`
          max-h-60 overflow-y-auto
          ${popupPlacement === 'top' ? 'flex flex-col-reverse' : ''}
        `}
      >
        {items.map((suggestion, index) => {
          const isFirst = index === 0;
          const isLast = index === items.length - 1;

          let roundingClasses = '';
          if (variant === 'inline') {
            if (popupPlacement === 'top') {
              // When reversed, swap the rounding
              if (isFirst) roundingClasses += 'rounded-b-lg ';
              if (isLast) roundingClasses += 'rounded-t-lg';
            } else {
              if (isFirst) roundingClasses += 'rounded-t-lg ';
              if (isLast) roundingClasses += 'rounded-b-lg';
            }
          } else {
            if (popupPlacement === 'top') {
              // When reversed, swap the rounding
              if (isFirst) roundingClasses += 'rounded-b-md ';
              if (isLast) roundingClasses += 'rounded-t-md';
            } else {
              if (isFirst) roundingClasses += 'rounded-t-md ';
              if (isLast) roundingClasses += 'rounded-b-md';
            }
          }

          return (
            <li
              key={`${suggestion.id}-${index}`}
              ref={el => {
                itemRefs.current[index] = el;
              }}
              className={`
                px-3 py-2 cursor-pointer transition-colors duration-150 ease-in-out
                hover:bg-gray-100 hover:dark:bg-gray-700
                ${selectedIndex === index ? 'bg-gray-100 dark:bg-gray-700' : ''}
                ${selectedIndex === index ? 'border-l-2 border-blue-500' : ''}
                ${roundingClasses}
              `}
              onClick={() => onSelect(suggestion)}
              onMouseEnter={() => onSelectionChange(index)}
            >
              <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {suggestion.label}
              </span>
              {suggestion.type && (
                <span className="text-xs text-gray-500 ml-auto">
                  {suggestion.type}
                </span>
              )}
            </div>
            {suggestion.description && (
              <div className="text-xs text-gray-500 mt-1 truncate">
                {suggestion.description}
              </div>
            )}
          </li>
          );
        })}
      </ul>
    );
  };

  // Get variant-specific classes
  const variantClasses = variant === 'inline' 
    ? 'fixed z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl min-w-56 max-w-sm backdrop-blur-sm bg-white/95 dark:bg-gray-800/95'
    : 'fixed z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg min-w-48 max-w-sm';

  return (
    <div
      className={`
        ${variantClasses}
        ${className || ''}
      `}
      style={{
        top: position.top,
        left: position.left,
        bottom: position.bottom,
        width: position.width ? `${position.width}px` : undefined,
      }}
    >
      {renderContent()}
    </div>
  );
}