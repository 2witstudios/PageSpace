import { useLayoutStore } from '@/stores/useLayoutStore';

export const useHasHydrated = () => {
  return useLayoutStore((state) => state.rehydrated);
};