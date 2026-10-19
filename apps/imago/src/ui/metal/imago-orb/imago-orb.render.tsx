import type { ReactNode, Ref } from 'react';
import { cn } from '../../cn';
import { imagoOrbClass, type OrbSize } from './imago-orb-class';

export type ImagoOrbRenderProps = {
  readonly size: OrbSize;
  /** No engine (the server, no WebGL2, a lost context): a still chrome ball instead. */
  readonly fallback: boolean;
  /** Its accessible name; decorative beside a visible "Imago" when omitted. */
  readonly label?: string;
  /** Retained classic surfaces size it with their own classes. */
  readonly className?: string;
  readonly canvasRef?: Ref<HTMLCanvasElement>;
};

/** Imago's liquid-metal orb: a canvas the engine draws into. */
export function renderImagoOrb({ size, fallback, label, className, canvasRef }: ImagoOrbRenderProps): ReactNode {
  return (
    <canvas
      ref={canvasRef}
      className={className === undefined ? imagoOrbClass(size, fallback) : cn(className, 'block flex-none', fallback && 'orb-chrome')}
      data-imago-orb={size}
      {...(label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
    />
  );
}
