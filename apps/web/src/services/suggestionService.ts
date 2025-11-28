import { MentionSuggestion, MentionType } from '@/types/mentions';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

export interface SuggestionApiError {
  message: string;
}

export interface SuggestionResult {
  suggestions: MentionSuggestion[];
  error?: SuggestionApiError;
}

export const suggestionApi = {
  fetchSuggestions: async (
    query: string,
    driveId: string | null,
    allowedTypes: MentionType[],
    crossDrive = false
  ): Promise<SuggestionResult> => {
    try {
      const types = allowedTypes.join(',');
      const params = new URLSearchParams({ q: query, types });
      
      if (crossDrive) {
        params.set('crossDrive', 'true');
      } else if (driveId) {
        params.set('driveId', driveId);
      } else {
        return {
          suggestions: [],
          error: { message: 'Drive ID is required for within-drive search' },
        };
      }
      
      const response = await fetchWithAuth(`/api/mentions/search?${params}`);
      if (!response.ok) {
        return {
          suggestions: [],
          error: { message: 'Failed to fetch suggestions' },
        };
      }
      const data = await response.json();
      return { suggestions: data };
    } catch {
      return {
        suggestions: [],
        error: { message: 'Failed to fetch suggestions' },
      };
    }
  },
};