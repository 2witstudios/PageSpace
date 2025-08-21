import { createContext, useContext, useState } from 'react';
import { MentionSuggestion } from '@/types/mentions';
import { Position } from '@/services/positioningService';

export interface SuggestionContextProps {
  isOpen: boolean;
  items: MentionSuggestion[];
  selectedIndex: number;
  position: Position | null;
  loading: boolean;
  error: string | null;
  open: (position: Position) => void;
  close: () => void;
  setItems: (items: MentionSuggestion[]) => void;
  setSelectedIndex: (index: number) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const SuggestionContext = createContext<SuggestionContextProps | null>(null);

export const useSuggestionContext = () => {
  const context = useContext(SuggestionContext);
  if (!context) {
    throw new Error('useSuggestionContext must be used within a SuggestionProvider');
  }
  return context;
};

export const SuggestionProvider = ({ children }: { children: React.ReactNode }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [items, setItems] = useState<MentionSuggestion[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [position, setPosition] = useState<Position | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loggedSetItems = (newItems: MentionSuggestion[]) => {
    console.log('[SuggestionProvider] Setting items:', newItems.length, 'items');
    setItems(newItems);
  };

  const loggedSetLoading = (loading: boolean) => {
    console.log('[SuggestionProvider] Setting loading:', loading);
    setLoading(loading);
  };

  const loggedSetError = (error: string | null) => {
    console.log('[SuggestionProvider] Setting error:', error);
    setError(error);
  };

  const open = (position: Position) => {
    console.log('[SuggestionProvider] Opening popup at position:', position);
    setIsOpen(true);
    setPosition(position);
  };

  const close = () => {
    console.log('[SuggestionProvider] Closing popup');
    setIsOpen(false);
    setItems([]);
    setSelectedIndex(0);
    setPosition(null);
    setLoading(false);
    setError(null);
  };

  const value = {
    isOpen,
    items,
    selectedIndex,
    position,
    loading,
    error,
    open,
    close,
    setItems: loggedSetItems,
    setSelectedIndex,
    setLoading: loggedSetLoading,
    setError: loggedSetError,
  };

  return (
    <SuggestionContext.Provider value={value}>
      {children}
    </SuggestionContext.Provider>
  );
};