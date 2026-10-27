import type { ReactNode } from 'react';
import type { IconName } from '../components/icon/icon-names';
import { renderIcon } from '../components/icon/icon.render';
import { ImagoOrb } from './imago-orb/imago-orb';

/**
 * A page's icon in a list, a tab or a search result. Imago's own page is not one agent page
 * among others: it is drawn as Imago's orb, still until hovered.
 */
export const renderPageIcon = ({ icon, size, imago = false }: { readonly icon: IconName; readonly size: number; readonly imago?: boolean }): ReactNode =>
  imago ? <ImagoOrb size="glyph" /> : renderIcon({ name: icon, size });
