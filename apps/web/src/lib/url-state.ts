export type UrlUpdateMode = 'push' | 'replace';

export interface ChatUrlParamsUpdate {
  agentId?: string | null;
  conversationId?: string | null;
}

const updateUrlParams = (updates: ChatUrlParamsUpdate, mode: UrlUpdateMode) => {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const params = url.searchParams;

  if ('conversationId' in updates) {
    if (updates.conversationId) {
      params.set('c', updates.conversationId);
    } else {
      params.delete('c');
    }
  }

  if ('agentId' in updates) {
    if (updates.agentId) {
      params.set('agent', updates.agentId);
    } else {
      params.delete('agent');
    }
  }

  if (mode === 'replace') {
    window.history.replaceState({}, '', url.toString());
  } else {
    window.history.pushState({}, '', url.toString());
  }
};

export const getConversationId = (): string | null => {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('c');
};

export const getAgentId = (): string | null => {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('agent');
};

export const setConversationId = (id: string | null, mode: UrlUpdateMode = 'push') => {
  updateUrlParams({ conversationId: id }, mode);
};

export const setAgentId = (id: string | null, mode: UrlUpdateMode = 'push') => {
  updateUrlParams({ agentId: id }, mode);
};

export const clearConversationId = (mode: UrlUpdateMode = 'push') => {
  updateUrlParams({ conversationId: null }, mode);
};

export const clearAgentId = (mode: UrlUpdateMode = 'push') => {
  updateUrlParams({ agentId: null }, mode);
};

export const setChatParams = (updates: ChatUrlParamsUpdate, mode: UrlUpdateMode = 'push') => {
  updateUrlParams(updates, mode);
};
