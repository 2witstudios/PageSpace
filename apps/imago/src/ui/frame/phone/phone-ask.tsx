import Link from 'next/link';
import type { ReactNode } from 'react';
import { ImagoOrb } from '../../metal/imago-orb/imago-orb';
import { usePage } from '../../files/page-object/page-object';
import { pageTabOf } from '../tabs/tab-label';
import { phoneAskClass } from './phone-shell-class';

export type PhoneAskProps =
  | { readonly href: string; readonly onPress?: undefined }
  /** Void action: Ask was pressed, and Imago opens full-screen over the page. */
  | { readonly onPress: () => void; readonly href?: undefined };

/**
 * The floating "Ask" on a phone: over the Files tree it opens the drive's chat; over a page it
 * opens Imago full-screen on that page. Imago is a screen of its own on a phone.
 */
export function PhoneAsk({ href, onPress }: PhoneAskProps): ReactNode {
  const content = (
    <>
      <ImagoOrb size="glyph" live />
      Ask
    </>
  );
  if (href === undefined) {
    return (
      <button type="button" className={phoneAskClass} onClick={onPress}>
        {content}
      </button>
    );
  }
  return (
    <Link href={href} prefetch={true} className={phoneAskClass}>
      {content}
    </Link>
  );
}

/** Pages that bring their own composer: a floating Ask there would sit on top of it. */
export const hasOwnComposer = (type: string | undefined): boolean => type === 'CHANNEL' || type === 'AI_CHAT';

/** Ask over a page, unless the page already has a message box of its own. */
export function PhonePageAsk({ pageId, onPress }: { readonly pageId: string; readonly onPress: () => void }): ReactNode {
  const { data } = usePage(pageId);
  return hasOwnComposer(pageTabOf(data)?.type) ? null : <PhoneAsk onPress={onPress} />;
}
