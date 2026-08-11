'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * How loud a stream is right now, as a coarse level for a meter.
 *
 * WHY IT IS QUANTIZED AND NOT CONTINUOUS. The obvious implementation sets React
 * state from a `requestAnimationFrame` loop, which re-renders the component
 * sixty times a second for the whole call — and that component is inside the
 * chat surface, above a virtualized message list. Rounding to a small number of
 * buckets and only setting state when the BUCKET changes gives a meter that
 * looks identical and re-renders a couple of times a second while somebody is
 * speaking. A meter is a rough visual; it does not need float precision, and
 * paying sixty renders a second for precision nobody can see is how a live call
 * makes the rest of the app feel broken.
 *
 * WHY THE FAILURE MODE IS SILENCE, NOT AN ERROR. `AudioContext` is absent in
 * jsdom, absent in some embedded webviews, and can be refused outright by an
 * autoplay policy. None of that is a reason to interrupt a working voice call
 * with an error — the audio still flows through the provider's `<audio>`
 * element either way. A meter that cannot run simply reads zero.
 *
 * This hook is where the I/O lives, deliberately: everything it feeds is a pure
 * render of a number.
 */

/** Buckets, not pixels: the meter has this many distinguishable heights. */
const LEVELS = 8;

type AudioContextConstructor = new () => AudioContext;

const audioContextConstructor = (): AudioContextConstructor | null => {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
};

export function useAudioLevel(stream: MediaStream | null, active: boolean): number {
  const [level, setLevel] = useState(0);
  // The last bucket PUSHED to state. Kept in a ref so the loop can compare
  // without depending on state, which would restart the effect every change.
  const bucketRef = useRef(0);

  useEffect(() => {
    if (!active || !stream) {
      bucketRef.current = 0;
      setLevel(0);
      return;
    }

    const Ctor = audioContextConstructor();
    if (!Ctor || typeof requestAnimationFrame !== 'function') return;

    let context: AudioContext;
    let analyser: AnalyserNode;
    let source: MediaStreamAudioSourceNode;
    try {
      context = new Ctor();
      analyser = context.createAnalyser();
      // Small FFT: we want an amplitude envelope, not a spectrum, and a smaller
      // window costs less per frame.
      analyser.fftSize = 256;
      source = context.createMediaStreamSource(stream);
      source.connect(analyser);
    } catch {
      // A stream with no live audio track, or a context the browser refused.
      return;
    }

    const samples = new Uint8Array(analyser.frequencyBinCount);
    let frame = 0;
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      analyser.getByteTimeDomainData(samples);

      // Peak deviation from the 128 midpoint — a cheap stand-in for amplitude
      // that responds the way a person expects a mic meter to.
      let peak = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const deviation = Math.abs(samples[i] - 128);
        if (deviation > peak) peak = deviation;
      }

      const normalized = Math.min(1, peak / 128);
      const bucket = Math.round(normalized * LEVELS);
      if (bucket !== bucketRef.current) {
        bucketRef.current = bucket;
        setLevel(bucket / LEVELS);
      }

      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      source.disconnect();
      analyser.disconnect();
      // The context holds a hardware audio thread; leaking one per call is a
      // browser that eventually refuses to make any more of them.
      void context.close().catch(() => {});
      bucketRef.current = 0;
    };
  }, [stream, active]);

  return level;
}
