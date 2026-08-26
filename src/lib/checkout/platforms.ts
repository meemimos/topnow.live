import type { Platform } from "@prisma/client";

/**
 * Per-platform handle rules (#8).
 *
 * Platform is chosen *before* the handle, because the platform is what decides
 * whether a handle is valid and what it points at. Reversing the order means
 * validating a handle against nothing.
 *
 * The patterns are each platform's own published rule, not a shared
 * lowest-common-denominator: a GitHub name may not start or end with a hyphen,
 * a Reddit name is at least three characters, and so on. Being strict here is
 * what makes the derived URL trustworthy.
 */
export type HandleRule = {
  /** Shown before the input, and used to build the target URL. */
  prefix: string;
  pattern: RegExp;
  minLength: number;
  maxLength: number;
  /** Placeholder text — a shape, not an instruction. */
  example: string;
  /** Said when the pattern rejects the handle. Specific, never "invalid input". */
  requirement: string;
};

export const HANDLE_RULES = {
  github: {
    prefix: "github.com/",
    pattern: /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/,
    minLength: 1,
    maxLength: 39,
    // Not the prototype's "mira_builds": GitHub usernames allow only letters,
    // numbers and single hyphens, so the mockup's handle is not a real one.
    example: "mira-builds",
    requirement:
      "GitHub names use letters, numbers and single hyphens, and cannot start or end with a hyphen.",
  },
  youtube: {
    prefix: "youtube.com/@",
    pattern: /^[a-zA-Z0-9._-]{3,30}$/,
    minLength: 3,
    maxLength: 30,
    example: "parcelkit",
    requirement:
      "YouTube handles are 3–30 characters: letters, numbers, dots, dashes, underscores.",
  },
  instagram: {
    prefix: "instagram.com/",
    pattern: /^(?!.*\.\.)[a-zA-Z0-9._]{1,30}$/,
    minLength: 1,
    maxLength: 30,
    example: "studio.offcut",
    requirement:
      "Instagram handles are up to 30 characters: letters, numbers, dots and underscores, with no double dots.",
  },
  tiktok: {
    prefix: "tiktok.com/@",
    pattern: /^[a-zA-Z0-9._]{2,24}$/,
    minLength: 2,
    maxLength: 24,
    example: "halfbuilt",
    requirement: "TikTok handles are 2–24 characters: letters, numbers, dots and underscores.",
  },
  reddit: {
    prefix: "reddit.com/user/",
    pattern: /^[a-zA-Z0-9_-]{3,20}$/,
    minLength: 3,
    maxLength: 20,
    example: "kerncase",
    requirement: "Reddit usernames are 3–20 characters: letters, numbers, underscores and hyphens.",
  },
} as const satisfies Record<Exclude<Platform, "web">, HandleRule>;

export type HandlePlatform = keyof typeof HANDLE_RULES;

export function isHandlePlatform(platform: Platform): platform is HandlePlatform {
  return platform !== "web";
}

/**
 * The target URL, derived rather than typed.
 *
 * There is no free link field for these platforms. A field a user can type any
 * URL into is both a validation hole and an abuse vector (#17) — deriving it
 * means the link always matches the handle on display.
 */
export function deriveTargetUrl(platform: HandlePlatform, handle: string): string {
  return `https://${HANDLE_RULES[platform].prefix}${handle}`;
}

/** Websites have no handle to show, so they carry a display name instead. */
export const DISPLAY_NAME_MAX = 24;
export const TAGLINE_MAX = 60;
