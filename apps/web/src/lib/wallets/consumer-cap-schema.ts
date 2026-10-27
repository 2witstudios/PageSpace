import { z } from 'zod';

const capCents = z.number().int().min(0).max(2_147_483_647).nullable();

/** A per-consumer cap write (WAL-7): whole cents per window; null = no cap; omitted = keep (or the default when enabling). */
export const consumerCapSchema = z.object({
  dailyCapCents: capCents.optional(),
  monthlyCapCents: capCents.optional(),
}).strict();
