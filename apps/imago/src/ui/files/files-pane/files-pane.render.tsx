import type { ReactNode } from 'react';
import { renderIconButton } from '../../components/icon-button/icon-button.render';

export type NewPageButtonRenderProps = {
  /** Void action: creates a document where the selection says. */
  readonly create: () => void;
  /** Off until the drive's tree loads (nowhere to put it) and while a create is in flight. */
  readonly disabled: boolean;
};

/** + in the pane header: a new document in the selected folder. */
export function renderNewPageButton({ create, disabled }: NewPageButtonRenderProps): ReactNode {
  return renderIconButton({ name: 'plus', label: 'New page', disabled, onClick: create });
}
