export type ResumeBootstrapEffect = 'rejoin' | 'reload' | 'stop';

/**
 * The app-resume effects, in order (epic leaf 6.2). Re-bootstrapping active streams and
 * reloading the conversation into the cache are unconditional — nothing renders from the
 * local fetch under store-first rendering, so there is no native/web or was-i-streaming
 * choreography left to make. The only guard is never stopping a genuinely live own stream.
 */
export const planResumeBootstrap = (isOwnStreamLive: boolean): ResumeBootstrapEffect[] =>
  isOwnStreamLive ? ['rejoin', 'reload'] : ['rejoin', 'reload', 'stop'];
