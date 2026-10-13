import type { ReactNode } from 'react';
import { isImagoEnabled } from '@/lib/imago/imago-enabled';
import { V3_HEADING } from './auth-v3-styles';

interface ConsentScopeCardProps {
  /** The consent question, e.g. "PageSpace CLI is requesting access". */
  title: string;
  /** Adds the "Built by PageSpace" badge. */
  firstParty: boolean;
  /** One row per granted scope, already rendered to human text. */
  scopeDescriptions: string[];
  /** Heading level: 1 when this card is the page heading, 2 under a page heading. */
  headingLevel?: 1 | 2;
  /** Action buttons and status, rendered under the scope list. */
  children?: ReactNode;
}

/**
 * The consent narration shared by /activate (device flow) and /oauth/consent.
 * Classic markup is unchanged; the v3 card is used only when Imago is enabled.
 */
export function ConsentScopeCard({
  title,
  firstParty,
  scopeDescriptions,
  headingLevel = 1,
  children,
}: ConsentScopeCardProps) {
  const v3 = isImagoEnabled();
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const badge = firstParty ? (
    v3 ? (
      <span className="ml-2 align-middle rounded-full bg-[oklch(0.50_0.16_235/0.10)] px-2 py-0.5 text-xs font-medium text-[oklch(0.42_0.16_235)]">
        Built by PageSpace
      </span>
    ) : (
      <span className="ml-2 rounded bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
        Built by PageSpace
      </span>
    )
  ) : null;

  if (v3) {
    return (
      <div>
        <Heading className={V3_HEADING}>
          {title}
          {badge}
        </Heading>
        <ul className="mt-6 overflow-hidden rounded-xl border border-[oklch(0.90_0.005_230)] bg-[oklch(0.995_0.002_240)]">
          {scopeDescriptions.map((text, i) => (
            <li
              key={i}
              className={`flex gap-2.5 px-3.5 py-3 text-[13.5px] leading-[1.5] text-[oklch(0.15_0.01_220)]${i > 0 ? ' border-t border-[oklch(0.90_0.005_230/0.8)]' : ''}`}
            >
              {text}
            </li>
          ))}
        </ul>
        {children}
      </div>
    );
  }

  return (
    <>
      <Heading className={headingLevel === 1 ? 'text-xl font-semibold' : 'text-lg font-medium'}>
        {title}
        {badge}
      </Heading>
      <ul className="mt-4 space-y-3 text-sm">
        {scopeDescriptions.map((text, i) => (
          <li key={i} className="rounded border p-3">
            {text}
          </li>
        ))}
      </ul>
      {children}
    </>
  );
}
