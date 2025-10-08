/**
 * Cookie-based conversation state management
 * Simple and works everywhere - dashboard, sidebar, across navigation
 */

import { post } from '@/lib/auth-fetch';

const ACTIVE_CONVERSATION_COOKIE = 'activeConversationId';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/**
 * Client-side utilities for conversation state
 */
export const conversationState = {
  /**
   * Get the active conversation ID from cookies (client-side)
   */
  getActiveConversationId(): string | null {
    if (typeof document === 'undefined') return null;
    
    try {
      const cookies = document.cookie.split(';');
      const cookie = cookies.find(c => c.trim().startsWith(`${ACTIVE_CONVERSATION_COOKIE}=`));
      return cookie ? cookie.split('=')[1] : null;
    } catch (error) {
      console.error('Error getting active conversation ID:', error);
      return null;
    }
  },

  /**
   * Set the active conversation ID in cookies (client-side)
   */
  setActiveConversationId(conversationId: string | null) {
    if (typeof document === 'undefined') return;
    
    try {
      if (conversationId) {
        const maxAge = COOKIE_MAX_AGE;
        const secure = window.location.protocol === 'https:';
        document.cookie = `${ACTIVE_CONVERSATION_COOKIE}=${conversationId}; max-age=${maxAge}; path=/; ${secure ? 'secure;' : ''} samesite=lax`;
      } else {
        document.cookie = `${ACTIVE_CONVERSATION_COOKIE}=; max-age=0; path=/`;
      }
    } catch (error) {
      console.error('Error setting active conversation ID:', error);
    }
  },

  /**
   * Create a new conversation and set it as active
   */
  async createAndSetActiveConversation(options: {
    title?: string;
    type?: 'global' | 'page' | 'drive';
    contextId?: string;
  } = {}) {
    try {
      const conversation = await post<{
        id: string;
        title: string;
        type: string;
        lastMessageAt: string;
        createdAt: string;
      }>('/api/ai_conversations', {
        title: options.title,
        type: options.type || 'global',
        contextId: options.contextId,
      });

      this.setActiveConversationId(conversation.id);
      return conversation;
    } catch (error) {
      console.error('Error creating conversation:', error);
      throw error;
    }
  },

  /**
   * Switch to a different conversation
   */
  switchToConversation(conversationId: string) {
    this.setActiveConversationId(conversationId);
    // Trigger a page refresh or state update to load the new conversation
    window.location.reload();
  },

  /**
   * Start a new conversation
   */
  async startNewConversation() {
    const conversation = await this.createAndSetActiveConversation();
    return conversation;
  },
};