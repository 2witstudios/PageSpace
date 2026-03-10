import { useState, useEffect, useCallback } from 'react';
import { UIMessage } from 'ai';
import { useVoiceModeStore, type VoiceModeOwner } from '@/stores/useVoiceModeStore';
import { useDisplayPreferences } from '@/hooks/useDisplayPreferences';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

/**
 * Consolidated chat session hook for voice mode, error display, and display preferences.
 * Extracts shared logic from AiChatView, GlobalAssistantView, and SidebarChatTab.
 */
interface UseChatSessionOptions {
  owner: VoiceModeOwner;
  conversationId?: string | null;
  isStreaming: boolean;
  messages: UIMessage[];
  error: Error | undefined;
}

interface UseChatSessionReturn {
  isVoiceModeActive: boolean;
  handleVoiceModeToggle: () => void;
  lastAIResponse: { id: string; text: string } | null;
  showVoiceSettings: boolean;
  setShowVoiceSettings: React.Dispatch<React.SetStateAction<boolean>>;
  showError: boolean;
  setShowError: React.Dispatch<React.SetStateAction<boolean>>;
  isOpenAIConfigured: boolean;
  displayPreferences: ReturnType<typeof useDisplayPreferences>['preferences'];
}

export function useChatSession({
  owner,
  conversationId: _conversationId,
  isStreaming,
  messages,
  error,
}: UseChatSessionOptions): UseChatSessionReturn {
  const [showVoiceSettings, setShowVoiceSettings] = useState(false);
  const [lastAIResponse, setLastAIResponse] = useState<{ id: string; text: string } | null>(null);
  const [isOpenAIConfigured, setIsOpenAIConfigured] = useState(false);
  const [showError, setShowError] = useState(true);

  const isVoiceModeEnabled = useVoiceModeStore((s) => s.isEnabled);
  const voiceOwner = useVoiceModeStore((s) => s.owner);
  const enableVoiceMode = useVoiceModeStore((s) => s.enable);
  const disableVoiceMode = useVoiceModeStore((s) => s.disable);
  const isVoiceModeActive = isVoiceModeEnabled && voiceOwner === owner;

  const { preferences: displayPreferences } = useDisplayPreferences();

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

  useEffect(() => {
    if (!isVoiceModeActive) {
      setShowVoiceSettings(false);
    }
  }, [isVoiceModeActive]);

  useEffect(() => {
    if (!isVoiceModeActive || isStreaming) return;

    const lastAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistantMsg) {
      const textParts = lastAssistantMsg.parts?.filter((p) => p.type === 'text') || [];
      const text = textParts.map((p) => (p as { text: string }).text).join(' ');
      if (text.trim()) {
        setLastAIResponse((current) =>
          current?.id === lastAssistantMsg.id
            ? current
            : { id: lastAssistantMsg.id, text }
        );
      }
    }
  }, [messages, isStreaming, isVoiceModeActive]);

  useEffect(() => {
    if (error) setShowError(true);
  }, [error]);

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
    handleVoiceModeToggle,
    lastAIResponse,
    showVoiceSettings,
    setShowVoiceSettings,
    showError,
    setShowError,
    isOpenAIConfigured,
    displayPreferences,
  };
}
