/**
 * useVoiceModeChat - Shared hook for voice mode functionality in AI chat views
 *
 * Consolidates voice mode state management, toggle handling, and OpenAI config check.
 * Used by GlobalAssistantView, SidebarChatTab, and AiChatView.
 */

import { useState, useEffect, useCallback } from 'react';
import { useVoiceModeStore, type VoiceModeOwner } from '@/stores/useVoiceModeStore';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { UIMessage } from 'ai';

export interface VoiceModeChatOptions {
  owner: VoiceModeOwner;
  messages: UIMessage[];
  isStreaming: boolean;
}

export interface LastAIResponse {
  id: string;
  text: string;
}

export interface UseVoiceModeChatReturn {
  isVoiceModeActive: boolean;
  showVoiceSettings: boolean;
  setShowVoiceSettings: (show: boolean) => void;
  isOpenAIConfigured: boolean;
  lastAIResponse: LastAIResponse | null;
  handleVoiceModeToggle: () => void;
}

export function useVoiceModeChat({
  owner,
  messages,
  isStreaming,
}: VoiceModeChatOptions): UseVoiceModeChatReturn {
  const [showVoiceSettings, setShowVoiceSettings] = useState(false);
  const [lastAIResponse, setLastAIResponse] = useState<LastAIResponse | null>(null);
  const [isOpenAIConfigured, setIsOpenAIConfigured] = useState(false);

  const isVoiceModeEnabled = useVoiceModeStore((state) => state.isEnabled);
  const voiceOwner = useVoiceModeStore((state) => state.owner);
  const enableVoiceMode = useVoiceModeStore((state) => state.enable);
  const disableVoiceMode = useVoiceModeStore((state) => state.disable);
  const isVoiceModeActive = isVoiceModeEnabled && voiceOwner === owner;

  // Check if OpenAI is configured (required for voice mode)
  useEffect(() => {
    const checkOpenAI = async () => {
      try {
        const response = await fetchWithAuth('/api/ai/settings');
        if (response.ok) {
          const data = await response.json();
          setIsOpenAIConfigured(data.providers?.openai?.isConfigured ?? false);
        }
      } catch {
        setIsOpenAIConfigured(false);
      }
    };
    checkOpenAI();
  }, []);

  // Reset voice settings when voice mode is deactivated
  useEffect(() => {
    if (!isVoiceModeActive) {
      setShowVoiceSettings(false);
    }
  }, [isVoiceModeActive]);

  // Track last AI response for voice mode TTS
  useEffect(() => {
    if (!isVoiceModeActive || isStreaming) return;

    const lastAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistantMsg) {
      const textParts = lastAssistantMsg.parts?.filter((p: { type: string }) => p.type === 'text') || [];
      const text = textParts.map((p: { text: string }) => p.text).join(' ');
      if (text.trim()) {
        setLastAIResponse((current) =>
          current?.id === lastAssistantMsg.id
            ? current
            : { id: lastAssistantMsg.id, text }
        );
      }
    }
  }, [messages, isStreaming, isVoiceModeActive]);

  // Voice mode toggle handler
  const handleVoiceModeToggle = useCallback(() => {
    if (isVoiceModeActive) {
      disableVoiceMode();
      setShowVoiceSettings(false);
    } else {
      enableVoiceMode(owner);
    }
  }, [isVoiceModeActive, enableVoiceMode, disableVoiceMode, owner]);

  return {
    isVoiceModeActive,
    showVoiceSettings,
    setShowVoiceSettings,
    isOpenAIConfigured,
    lastAIResponse,
    handleVoiceModeToggle,
  };
}
