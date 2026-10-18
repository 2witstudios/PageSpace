import { useId, type ReactNode } from 'react';
import { cn } from '../../cn';

export type ImagoOrbProps = {
  /** The box's side in px; the orb is drawn on a 24-unit square. */
  readonly size?: number;
  readonly className?: string;
};

/**
 * Imago's mark: a chrome-like mirror sphere. It reflects a bright sky over a hard dark
 * horizon with a light bounce from below, a crisp window highlight, and a dark Fresnel
 * edge. Siri-like colour reflections drift across it, and the glints twinkle. The
 * keyframes live in globals.css, so reduced motion holds the orb still.
 * It is decorative: the name beside it says who is talking.
 */
export function ImagoOrb({ size = 16, className }: ImagoOrbProps): ReactNode {
  const id = useId();
  const clip = `${id}-clip`;
  const env = `${id}-env`;
  const edge = `${id}-edge`;
  const blur = `${id}-blur`;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={cn('imago-orb block shrink-0', className)}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={clip}>
          <circle cx="12" cy="12" r="10.5" />
        </clipPath>
        {/* The environment, top to bottom: sky, hard horizon at the middle, dark ground,
            then a pale bounce of light from below. */}
        <linearGradient id={env} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f2fbff" />
          <stop offset="0.36" stopColor="#8cc4f0" />
          <stop offset="0.5" stopColor="#141d44" />
          <stop offset="0.7" stopColor="#0a1030" />
          <stop offset="0.88" stopColor="#4a5bc4" />
          <stop offset="1" stopColor="#b5e6ff" />
        </linearGradient>
        {/* Fresnel: the sphere's edge turns away from the eye, so it darkens. */}
        <radialGradient id={edge} cx="0.42" cy="0.4" r="0.62">
          <stop offset="0.6" stopColor="#050818" stopOpacity="0" />
          <stop offset="1" stopColor="#050818" stopOpacity="0.75" />
        </radialGradient>
        <filter id={blur} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="1.2" />
        </filter>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <circle cx="12" cy="12" r="10.5" fill={`url(#${env})`} />
        <g filter={`url(#${blur})`} opacity="0.8" className="imago-orb__swirl">
          <ellipse cx="7.5" cy="8.5" rx="5" ry="2.6" fill="#5ac8fa" />
          <ellipse cx="16" cy="12.5" rx="5" ry="3" fill="#bf5af2" />
          <ellipse cx="10.5" cy="16.5" rx="4.5" ry="2.2" fill="#ff6fa8" opacity="0.55" />
        </g>
        <circle cx="12" cy="12" r="10.5" fill={`url(#${edge})`} />
        <rect x="0" y="11.8" width="24" height="0.5" fill="#ffffff" opacity="0.35" />
      </g>
      <ellipse cx="8.4" cy="6.2" rx="2.6" ry="1.2" fill="#ffffff" transform="rotate(-28 8.4 6.2)" />
      <ellipse cx="9" cy="6.6" rx="4.6" ry="2.4" fill="#ffffff" opacity="0.25" transform="rotate(-28 9 6.6)" />
      <circle cx="12" cy="12" r="10.1" fill="none" stroke="#d8f2ff" strokeOpacity="0.35" strokeWidth="0.5" />
      <circle cx="12" cy="12" r="10.5" fill="none" stroke="#050818" strokeOpacity="0.6" strokeWidth="0.5" />
      <path
        d="M19.6 2.6 L20.1 4.1 L21.6 4.6 L20.1 5.1 L19.6 6.6 L19.1 5.1 L17.6 4.6 L19.1 4.1 Z"
        fill="#ffffff"
        className="imago-orb__glint"
      />
      <circle cx="4.9" cy="16.6" r="0.9" fill="#ffffff" className="imago-orb__glint imago-orb__glint--late" />
    </svg>
  );
}
