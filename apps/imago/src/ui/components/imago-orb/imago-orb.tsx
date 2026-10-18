import { useId, type ReactNode } from 'react';
import { cn } from '../../cn';

export type ImagoOrbProps = {
  /** The box's side in px; the orb is drawn on a 24-unit square. */
  readonly size?: number;
  readonly className?: string;
};

/**
 * Imago's mark: a liquid-metal sphere, the opposite of glass. It is opaque and dense,
 * with hard high-contrast bands of reflected light and a few tinted sheens, and its
 * silhouette wobbles like a drop of mercury. The reflections flow across the surface;
 * the keyframes live in globals.css, so reduced motion holds the orb still.
 * It is decorative: the name beside it says who is talking.
 */
export function ImagoOrb({ size = 16, className }: ImagoOrbProps): ReactNode {
  const id = useId();
  const clip = `${id}-clip`;
  const metal = `${id}-metal`;
  const wobble = `${id}-wobble`;
  const edge = `${id}-edge`;
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
        {/* Hard bands of reflected light, top to bottom: a bright lip, a dark slab, a
            white strip, a black horizon, then cool grey and a pale floor. No sky glow:
            liquid metal reflects, it does not let light through. */}
        <linearGradient id={metal} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.14" stopColor="#9aa6b8" />
          <stop offset="0.3" stopColor="#2a2f3d" />
          <stop offset="0.46" stopColor="#f0f4ff" />
          <stop offset="0.53" stopColor="#0b0d14" />
          <stop offset="0.7" stopColor="#6b7aa6" />
          <stop offset="0.84" stopColor="#1a1d2a" />
          <stop offset="0.93" stopColor="#d9e2ff" />
          <stop offset="1" stopColor="#3b4256" />
        </linearGradient>
        {/* The silhouette: a low-frequency turbulence bends the edge a pixel or so. */}
        <filter id={wobble} x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="2" seed="4" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="2.2" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <radialGradient id={edge} cx="0.4" cy="0.36" r="0.66">
          <stop offset="0.7" stopColor="#05060b" stopOpacity="0" />
          <stop offset="1" stopColor="#05060b" stopOpacity="0.85" />
        </radialGradient>
      </defs>
      <g filter={`url(#${wobble})`}>
        <g clipPath={`url(#${clip})`}>
          <circle cx="12" cy="12" r="10.5" fill={`url(#${metal})`} />
          {/* Tinted sheens that slide round the sphere with the flow. */}
          <g className="imago-orb__flow">
            <ellipse cx="7" cy="9" rx="4.2" ry="1.1" fill="#7c4dff" opacity="0.75" transform="rotate(-18 7 9)" />
            <ellipse cx="17" cy="14.5" rx="4.6" ry="1" fill="#2ad1c9" opacity="0.7" transform="rotate(14 17 14.5)" />
            <ellipse cx="11" cy="17.5" rx="3.6" ry="0.9" fill="#ff5fa2" opacity="0.6" />
          </g>
          <circle cx="12" cy="12" r="10.5" fill={`url(#${edge})`} />
          <rect x="0" y="11.9" width="24" height="0.35" fill="#ffffff" opacity="0.5" />
        </g>
        {/* The sharp specular: a narrow hot streak, not a soft window. */}
        <ellipse cx="8.2" cy="6.1" rx="2.2" ry="0.7" fill="#ffffff" transform="rotate(-30 8.2 6.1)" />
        <path d="M5.2 9.6 Q6.6 6.4 10.8 5.2" fill="none" stroke="#ffffff" strokeOpacity="0.9" strokeWidth="0.45" strokeLinecap="round" />
        <circle cx="12" cy="12" r="10.1" fill="none" stroke="#e6ecff" strokeOpacity="0.45" strokeWidth="0.4" />
      </g>
      <path
        d="M19.6 2.6 L20.1 4.1 L21.6 4.6 L20.1 5.1 L19.6 6.6 L19.1 5.1 L17.6 4.6 L19.1 4.1 Z"
        fill="#ffffff"
        className="imago-orb__glint"
      />
      <circle cx="4.9" cy="16.6" r="0.9" fill="#ffffff" className="imago-orb__glint imago-orb__glint--late" />
    </svg>
  );
}
