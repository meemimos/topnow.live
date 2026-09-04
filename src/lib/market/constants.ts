/**
 * The market panel's thresholds (#13).
 *
 * Named here once and shared with the chart (#12), because a threshold spelled
 * out in two places is a threshold that will eventually disagree with itself —
 * the panel would claim it has too little data to draw while the chart drew
 * anyway, or the reverse.
 */

/**
 * Hours of *sampled ask* a slot needs before the chart is drawn at all.
 *
 * Decision D3. Twenty hours of real samples (#22), never twenty sales and never
 * twenty of anything generated to trip the threshold. Below this the panel shows
 * the sparse state instead — which is not a failure mode: on day one it is the
 * only market state that exists.
 */
export const MARKET_REVEAL_HOURS = 20;

/** How many trailing candles the flat check looks at. */
export const FLAT_WINDOW_CANDLES = 6;

/**
 * How far from base a candle may sit and still count as flat: 1.5%.
 *
 * Expressed against base rather than in cents, so it means the same thing on a
 * $5.00 slot and a $2.00 one.
 */
export const FLAT_TOLERANCE = 0.015;

/**
 * Candles a range must contain before the chart is drawn for it.
 *
 * Below this there is no movement to show, and one lonely candle in a 12-hour
 * window is a stub rather than a chart — #12 asks for the sparse note instead.
 * Two is the minimum that can depict a change at all.
 *
 * Distinct from `MARKET_REVEAL_HOURS`, which is about the slot's whole history:
 * a slot can be a real market and still have a quiet range selected.
 */
export const MIN_CANDLES_IN_RANGE = 2;

/** Below this width the chart collapses to a sparkline with a control to expand it. */
export const SPARKLINE_MAX_WIDTH = 620;

/** The ranges the chart offers, in hours. `5D` is the prototype's label for 120h. */
export const RANGES = [
  { hours: 12, label: "12H" },
  { hours: 24, label: "24H" },
  { hours: 48, label: "48H" },
  { hours: 120, label: "5D" },
] as const;

export type RangeHours = (typeof RANGES)[number]["hours"];
export const DEFAULT_RANGE_HOURS: RangeHours = 24;
