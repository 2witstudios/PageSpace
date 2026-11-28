import { create } from 'zustand';
import type { OrgSignInDenial } from '@/retained/lib/auth/org-sign-in-denial';

/**
 * The re-authentication prompt's state (D-OW-45). The shared fetch layer reports every org sign-in denial here; the
 * one prompt mounted in the app shell opens on it. Denials pile up while it is open (several requests can be refused
 * at once), so the prompt can name every org that asked.
 */
interface OrgReauthState {
  denials: OrgSignInDenial[];
  report: (denial: OrgSignInDenial) => void;
  dismiss: () => void;
}

const same = (a: OrgSignInDenial, b: OrgSignInDenial) => a.code === b.code && a.orgId === b.orgId;

export const useOrgReauthStore = create<OrgReauthState>((set) => ({
  denials: [],
  report: (denial) => set((state) => (state.denials.some((d) => same(d, denial)) ? state : { denials: [...state.denials, denial] })),
  dismiss: () => set({ denials: [] }),
}));
