// The rollout switch (DEC-10): only the exact value 'true' turns imago on, in
// every deployment mode. Read per call, never at module load, so the running
// server follows the env it was started with rather than the one it was built
// with. Dot access keeps `IMAGO_ENABLED` visible to the edge (middleware)
// runtime, which exposes only the env vars the bundle references.
export const isImagoEnabled = (): boolean => process.env.IMAGO_ENABLED === 'true';
