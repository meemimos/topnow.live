import { z } from "zod";

import { InvalidPostUrlError, normalisePostUrl, providerFor } from "@/lib/embed/providers";
import { DURATION_HOURS, SLOTS } from "@/lib/pricing";

import {
  DISPLAY_NAME_MAX,
  HANDLE_RULES,
  TAGLINE_MAX,
  deriveTargetUrl,
  type HandlePlatform,
} from "./platforms";

/**
 * The checkout form's shape (#8).
 *
 * One schema, used by the form and by the server. Client-side validation is a
 * convenience; the server re-validates everything, because a form is not a
 * security boundary and anyone can post whatever they like to the endpoint.
 */

const slot = z.union(
  SLOTS.map((s) => z.literal(s)) as [z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>],
);

/** Never an arbitrary number of hours — only the five snap points. */
const durationH = z.union(
  DURATION_HOURS.map((h) => z.literal(h)) as unknown as [
    z.ZodLiteral<1>,
    z.ZodLiteral<3>,
    z.ZodLiteral<6>,
    z.ZodLiteral<12>,
    z.ZodLiteral<24>,
  ],
);

const tagline = z
  .string()
  .trim()
  .min(1, "One line of copy is required.")
  .max(TAGLINE_MAX, `Keep it to ${TAGLINE_MAX} characters.`)
  // A tagline is one line. A newline would break the row it is rendered in.
  .refine((value) => !/[\r\n]/.test(value), "One line only.");

function handleSchema(platform: HandlePlatform) {
  const rule = HANDLE_RULES[platform];
  return z
    .string()
    .trim()
    .min(rule.minLength, `A ${platform} handle is required.`)
    .max(rule.maxLength, `${rule.maxLength} characters at most.`)
    .regex(rule.pattern, rule.requirement);
}

/**
 * The post to embed on slot 01 (#20). Optional everywhere, and only offered on
 * the three platforms with a public oEmbed endpoint.
 *
 * A listing carries a *profile* handle, and oEmbed takes a *post* URL — so
 * without this field there is nothing for #20 to resolve. It is the smallest
 * change that makes the embedded post panel possible at all.
 *
 * Unlike the target URL, this one cannot be derived: only the buyer knows which
 * of their posts they want on the board. It is therefore validated hard —
 * https, the platform's own host, and a path that looks like a post rather than
 * a profile — before it is ever sent anywhere.
 */
const postUrl = z.string().trim().max(2048, "That link is too long.").optional();

const handleListing = z
  .object({
    slot,
    durationH,
    tagline,
    platform: z.enum(["github", "youtube", "instagram", "tiktok", "reddit"]),
    handle: z.string(),
    postUrl,
  })
  .superRefine((value, ctx) => {
    const result = handleSchema(value.platform).safeParse(value.handle);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ code: "custom", path: ["handle"], message: issue.message });
      }
    }

    if (!value.postUrl) return;

    if (!providerFor(value.platform)) {
      ctx.addIssue({
        code: "custom",
        path: ["postUrl"],
        message: "This platform has no post embed. Leave this blank.",
      });
      return;
    }

    try {
      normalisePostUrl(value.platform, value.postUrl);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["postUrl"],
        message:
          error instanceof InvalidPostUrlError ? error.message : "That is not a usable post link.",
      });
    }
  })
  .transform((value) => ({
    ...value,
    handle: value.handle.trim(),
    displayName: null,
    // Derived, never supplied.
    targetUrl: deriveTargetUrl(value.platform, value.handle.trim()),
    // Normalised here so the cache key is settled before the row is written and
    // two links to the same post cannot become two cache entries.
    postUrl: value.postUrl ? normalisePostUrl(value.platform, value.postUrl) : null,
  }));

const websiteListing = z
  .object({
    slot,
    durationH,
    tagline,
    platform: z.literal("web"),
    displayName: z
      .string()
      .trim()
      .min(1, "A display name is required.")
      .max(DISPLAY_NAME_MAX, `${DISPLAY_NAME_MAX} characters at most.`),
    url: z
      .string()
      .trim()
      .min(1, "A URL is required.")
      .refine((value) => {
        // https only. The scheme is also enforced by a check constraint (#21),
        // but a javascript: or data: URL should never get that far.
        try {
          return new URL(value).protocol === "https:";
        } catch {
          return false;
        }
      }, "Must be a full https:// address."),
  })
  .transform((value) => ({
    slot: value.slot,
    durationH: value.durationH,
    tagline: value.tagline,
    platform: value.platform,
    // A website has no handle, and the schema's check constraint requires the
    // column to be empty for anything but a display name.
    handle: "",
    displayName: value.displayName,
    targetUrl: new URL(value.url).toString(),
    // A website listing is a link, not a post. The database refuses one here
    // too (purchase_post_url_embeddable_platform).
    postUrl: null,
  }));

export const handleListingSchema = handleListing;
export const websiteListingSchema = websiteListing;

/**
 * Validates a submitted listing.
 *
 * Dispatched on platform rather than expressed as a discriminated union: both
 * branches carry a transform (deriving the target URL, normalising the handle),
 * and Zod cannot discriminate across transforms. A website and a handle listing
 * are genuinely different shapes anyway, not one shape with optional fields.
 */
export function parseCheckout(input: unknown) {
  const platform = (input as { platform?: unknown } | null)?.platform;
  return platform === "web" ? websiteListing.safeParse(input) : handleListing.safeParse(input);
}

/** Field-keyed errors, which is what a form needs to render them in place. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    out[key] ??= issue.message;
  }
  return out;
}

export type CheckoutInput = z.input<typeof handleListing> | z.input<typeof websiteListing>;
export type ParsedCheckout = z.output<typeof handleListing> | z.output<typeof websiteListing>;
