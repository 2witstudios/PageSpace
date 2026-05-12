'use client';

import { createContext, useContext, ReactNode } from 'react';
import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

interface FeatureTogglesContextValue {
  features: string[];
  hasFeature: (feature: string) => boolean;
  isLoading: boolean;
}

const FeatureTogglesContext = createContext<FeatureTogglesContextValue>({
  features: [],
  hasFeature: () => false,
  isLoading: false,
});

async function fetchFeatures(): Promise<string[]> {
  const res = await fetchWithAuth('/api/user/features');
  if (!res.ok) return [];
  const data = await res.json() as { features?: string[] };
  return data.features ?? [];
}

export function FeatureTogglesProvider({ children }: { children: ReactNode }) {
  const { data: features = [], isLoading } = useSWR<string[]>(
    'user-features',
    fetchFeatures,
    { revalidateOnFocus: false, dedupingInterval: 60_000 },
  );

  const hasFeature = (feature: string) => features.includes(feature);

  return (
    <FeatureTogglesContext.Provider value={{ features, hasFeature, isLoading }}>
      {children}
    </FeatureTogglesContext.Provider>
  );
}

export function useFeatureToggles() {
  return useContext(FeatureTogglesContext);
}
