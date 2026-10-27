import Link from 'next/link';
import type { ReactNode } from 'react';
import { ImagoOrb } from '../../metal/imago-orb/imago-orb';
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
