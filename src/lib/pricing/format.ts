/**
 * The strings every price-bearing surface renders.
 *
 * These live beside the engine rather than in the components so that a total and
 * the derivation printed under it can never disagree — they are produced from
 * one quote, in one place. #9 (receipt) and #14 (pricing dialog) both call these.
 */
import { BASE_MULTIPLIER_CM, MAX_MULTIPLIER_CM, QUEUE_CAP_HOURS } from "./constants";
import type { Quote } from "./index";

/** `2505` -> `"25.05"`. No currency symbol. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** `2505` -> `"$25.05"`. */
export function formatMoney(cents: number): string {
  return `$${formatCents(cents)}`;
}

/** `167` -> `"1.67"`. */
export function formatMultiplier(multiplierCm: number): string {
  return formatCents(multiplierCm);
}

/**
 * How a premium is expressed, everywhere. As a multiplier — never as a colour.
 * `167` -> `"1.67x base"`.
 */
export function formatMultiplierAgainstBase(multiplierCm: number): string {
  return `${formatMultiplier(multiplierCm)}× base`;
}

/** The receipt's line item: `"3H AT $8.35/HR"`. */
export function lineItem(quote: Quote): string {
  return `${quote.durationH}H AT ${formatMoney(quote.askHrCents)}/HR`;
}

/**
 * The derivation printed beneath the line item:
 * `"$5.00 BASE × 1.67 SURGE × 3H"`.
 *
 * A reader can multiply these three and get the total exactly, which is the
 * whole point of quantising the multiplier in the engine.
 */
export function derivation(quote: Quote): string {
  return [
    `${formatMoney(quote.baseHrCents)} BASE`,
    `${formatMultiplier(quote.multiplierCm)} SURGE`,
    `${quote.durationH}H`,
  ].join(" × ");
}

/** The button label, which states what happens: `"TAKE SLOT 01 — $25.05"`. */
export function actionLabel(quote: Quote, queued: boolean): string {
  const verb = queued ? "JOIN QUEUE FOR" : "TAKE";
  return `${verb} ${slotLabel(quote.slot)} — ${formatMoney(quote.totalCents)}`;
}

/** `1` -> `"SLOT 01"`. */
export function slotLabel(slot: number): string {
  return `SLOT ${String(slot).padStart(2, "0")}`;
}

/** Whether a surge note should appear at all. Below this there is nothing to say. */
export function hasSurge(multiplierCm: number): boolean {
  return multiplierCm > BASE_MULTIPLIER_CM;
}

/**
 * How surge actually moves, in the terms the engine actually uses (#14).
 *
 * The prototype's wording — "every person who joins a slot's queue pushes that
 * slot's surge up" — describes head count, and the implemented model is driven
 * by **queued hours** (decision D2). Under head count, four people booking one
 * hour each would move the price as much as four booking a day each, which is
 * not what happens and not what a buyer would see.
 *
 * Generated from the constants rather than written out, so the sentence cannot
 * drift from the model: change the cap and this copy changes with it.
 */
export function surgeExplanation(): string {
  return (
    `Surge is driven by the hours queued on a slot, not by how many people are ` +
    `waiting — four people booking an hour each move it far less than four ` +
    `booking a day each. Every queued hour lifts the rate, reaching the ${formatMultiplier(MAX_MULTIPLIER_CM)}× ` +
    `ceiling at ${QUEUE_CAP_HOURS} queued hours, which is also the point a slot stops ` +
    `accepting bookings. An unsold hour pulls the rate back toward base, so it ` +
    `climbs with demand and only time brings it down.`
  );
}

/** The flat-rate rule, with the cap stated (#14). */
export function flatRateRule(): string {
  return (
    `The rate is flat per hour. Six hours costs exactly six times one hour — no ` +
    `bulk discount, no long-hold premium. Surge is capped at ${formatMultiplier(MAX_MULTIPLIER_CM)}× and only ` +
    `rises while a slot's queue is deep.`
  );
}

/** The opening line: the whole model in one sentence. */
export const PRICING_OPENING =
  "You pay a rate per hour, multiplied by the hours you book, multiplied by the " +
  "slot's current surge. Nothing compounds and nothing is hidden.";
