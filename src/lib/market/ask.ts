import type { Prisma } from "@prisma/client";

import { BASE_MULTIPLIER_CM, type Slot } from "@/lib/pricing";

/**
 * Reading the ask back out of the sampled series.
 *
 * Deliberately a module of its own, importing nothing from `purchase/`: the
 * queue needs this to quote a decayed ask, and the sampler needs it to carry
 * decay forward, but the sampler already depends on the state machine. Putting
 * it here keeps that from becoming a cycle.
 */

/** `askHrCents` and `baseHrCents` expressed as a multiplier in hundredths. */
export function sampleToMultiplierCm(sample: { askHrCents: number; baseHrCents: number }): number {
  return Math.round((sample.askHrCents * BASE_MULTIPLIER_CM) / sample.baseHrCents);
}

export type SampledAsk = { multiplierCm: number; hour: Date };

/**
 * The most recently sampled ask for a slot, or null before the first sample.
 *
 * This is what carries decay between hours: the ask jumps up with demand and
 * bleeds back toward base over unsold hours, and the memory lives in the sample
 * rather than a mutable column so the series stays reconstructible.
 */
export async function latestSampledAsk(
  client: Prisma.TransactionClient,
  slot: Slot,
): Promise<SampledAsk | null> {
  const sample = await client.askSample.findFirst({
    where: { slot },
    orderBy: { hour: "desc" },
    select: { askHrCents: true, baseHrCents: true, hour: true },
  });
  if (!sample) return null;

  return { multiplierCm: sampleToMultiplierCm(sample), hour: sample.hour };
}
