interface EndablePool {
  /** Set by pg once `end()` has been called. */
  ending: boolean;
  end: () => Promise<void>;
}

/**
 * End an integration file's `@pagespace/db` pool unless the suite already did.
 * pg throws if `end()` is called twice.
 */
export async function releaseAppPool(pool: EndablePool): Promise<void> {
  if (pool.ending) return;
  await pool.end();
}
