"use client";

import { useMemo, useState, useTransition } from "react";

import { priceCheckout, type CheckoutQuote } from "@/app/actions/checkout";
import { BevelButton } from "@/components/ui/bevel-button";
import { Plate } from "@/components/ui/plate";
import type { CheckoutInput } from "@/lib/checkout/schema";
import {
  DISPLAY_NAME_MAX,
  HANDLE_RULES,
  TAGLINE_MAX,
  deriveTargetUrl,
  type HandlePlatform,
} from "@/lib/checkout/platforms";
import { DURATIONS, SLOTS, type Slot } from "@/lib/pricing";
import { cn } from "@/lib/utils";

/**
 * The checkout form (#8).
 *
 * Platform is picked before the handle, because the platform decides what a
 * valid handle looks like and what it points at. The target link is derived and
 * shown read-only — there is no field to type a link into, which closes both a
 * validation hole and an abuse vector (#17).
 *
 * The receipt (#9) and the queue position (#10) render from the quote this
 * returns. The listing that produced the quote is handed up alongside it: #26
 * re-prices it on the server when the buyer takes the slot, so the figure sent
 * to Stripe is never one the browser could have edited in between.
 */

const PLATFORM_OPTIONS = [
  { value: "github", label: "GitHub" },
  { value: "youtube", label: "YouTube" },
  { value: "instagram", label: "Instagram" },
  { value: "tiktok", label: "TikTok" },
  { value: "reddit", label: "Reddit" },
  { value: "web", label: "Website" },
] as const;

type PlatformValue = (typeof PLATFORM_OPTIONS)[number]["value"];

function Step({ number, children }: { number: number; children: string }) {
  return (
    <div className="text-sm mb-1.5 font-pixel font-bold tracking-[0.04em]">
      {number} — {children}
    </div>
  );
}

/**
 * Platforms whose posts can be embedded (#20).
 *
 * The three with a public oEmbed endpoint. GitHub has no post, Instagram needs
 * an app token, and a website is a link rather than a post — so the field is
 * simply not shown for those, rather than shown and then rejected.
 */
const EMBEDDABLE = ["youtube", "tiktok", "reddit"] as const;
type EmbeddablePlatform = (typeof EMBEDDABLE)[number];

/** A shape, not an instruction — same convention as the handle placeholders. */
const POST_URL_EXAMPLE: Record<EmbeddablePlatform, string> = {
  youtube: "https://www.youtube.com/watch?v=...",
  tiktok: "https://www.tiktok.com/@handle/video/...",
  reddit: "https://www.reddit.com/r/sub/comments/...",
};

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <span className="text-md mt-1 block text-ink-soft" role="alert">
      {message}
    </span>
  );
}

/** Live counter. Present from the first keystroke, not only near the limit. */
function Counter({ value, max }: { value: string; max: number }) {
  const left = max - value.length;
  return (
    <span className="text-xs mt-1 block text-ink-soft" data-numeric>
      {left} characters left
    </span>
  );
}

/** What the form hands upward once a listing prices cleanly. */
export type PricedListing = { quote: CheckoutQuote; input: CheckoutInput };

export function CheckoutForm({ onQuote }: { onQuote?: (priced: PricedListing | null) => void }) {
  const [slot, setSlot] = useState<Slot>(1);
  const [durationIndex, setDurationIndex] = useState(1);
  const [platform, setPlatform] = useState<PlatformValue>("github");
  const [handle, setHandle] = useState("");
  const [url, setUrl] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [tagline, setTagline] = useState("");
  // Slot 01's embedded post (#20). Optional, and only offered on the platforms
  // that actually have a public oEmbed endpoint.
  const [postUrl, setPostUrl] = useState("");

  const embeddable = (EMBEDDABLE as readonly string[]).includes(platform);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  const duration = DURATIONS[durationIndex];
  const isWebsite = platform === "web";

  // Read-only helper text, not an input. Recomputed as the handle is typed so
  // the buyer can see exactly where the listing will point.
  const derivedUrl = useMemo(() => {
    if (isWebsite || handle.trim() === "") return null;
    return deriveTargetUrl(platform as HandlePlatform, handle.trim());
  }, [isWebsite, platform, handle]);

  function submit() {
    const payload: CheckoutInput =
      platform === "web"
        ? { slot, durationH: duration.hours, platform, displayName, url, tagline }
        : {
            slot,
            durationH: duration.hours,
            platform,
            handle,
            tagline,
            // Omitted rather than sent empty: the field is optional, and an
            // empty string is a value the schema would have to special-case.
            ...(embeddable && postUrl.trim() ? { postUrl: postUrl.trim() } : {}),
          };

    startTransition(async () => {
      const result = await priceCheckout(payload);
      if (result.ok) {
        setErrors({});
        onQuote?.({ quote: result.quote, input: payload });
      } else {
        setErrors(result.errors);
        onQuote?.(null);
      }
    });
  }

  return (
    <div className="bg-paper p-3">
      <fieldset className="mb-4 border-0 p-0">
        <legend className="sr-only">Pick a slot</legend>
        <Step number={1}>PICK A SLOT</Step>
        {/* Full-width thirds, as the prototype has them. Three small buttons
            floating at the left read as a filter; three that fill the column
            read as the choice the step is asking for. */}
        <div className="flex gap-1.5" role="radiogroup" aria-label="Slot">
          {SLOTS.map((value) => (
            <BevelButton
              key={value}
              role="radio"
              aria-checked={slot === value}
              selected={slot === value}
              onClick={() => setSlot(value)}
              className="flex-1"
            >
              {String(value).padStart(2, "0")}
            </BevelButton>
          ))}
        </div>
      </fieldset>

      <fieldset className="mb-4 border-0 p-0">
        <legend className="sr-only">Pick a duration</legend>
        <Step number={2}>FEED THE METER</Step>

        {/* The track sits in a well, as it does in the prototype: the meter is
            a physical thing being fed, and a bare range input on paper is the
            one control on this page that stops looking like the rest of it. */}
        <Plate variant="inset" className="px-2.5 py-2">
          {/* A slider that can only land on a snap point — never an arbitrary
              number of hours, which the server also refuses. */}
          <input
            type="range"
            min={0}
            max={DURATIONS.length - 1}
            step={1}
            value={durationIndex}
            onChange={(event) => setDurationIndex(Number(event.target.value))}
            className="w-full accent-navy"
            aria-label="Duration"
            aria-valuetext={`${duration.hours} hours — ${duration.name}`}
          />
          <div className="text-xs mt-1 flex justify-between font-pixel">
            {DURATIONS.map((d) => (
              <span key={d.hours} className={cn(d.hours === duration.hours && "font-bold")}>
                {d.hours}H
              </span>
            ))}
          </div>
        </Plate>
        <div className="text-md mt-1.5">
          <span className="font-pixel font-bold">{duration.hours}H</span>{" "}
          <span className="text-ink-soft">{duration.name}</span>
        </div>
      </fieldset>

      <fieldset className="border-0 p-0">
        <legend className="sr-only">Your listing</legend>
        <Step number={3}>YOUR LISTING</Step>

        <label className="mb-3 block">
          <span className="text-md mb-1 block">Platform</span>
          <select
            className="text-lg w-full border border-ink bg-paper px-2 py-1.5"
            value={platform}
            onChange={(event) => {
              // Changing platform re-validates whatever is already typed: the
              // same handle can be valid on one platform and not another.
              setPlatform(event.target.value as PlatformValue);
              setErrors({});
            }}
          >
            {PLATFORM_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {isWebsite ? (
          <>
            <label className="mb-3 block">
              <span className="text-md mb-1 block">URL</span>
              <input
                type="url"
                className="text-lg w-full border border-ink bg-paper px-2 py-1.5"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://ledgerless.dev"
                aria-invalid={Boolean(errors.url)}
              />
              <FieldError message={errors.url} />
            </label>

            <label className="mb-3 block">
              <span className="text-md mb-1 block">Display name</span>
              <input
                type="text"
                className="text-lg w-full border border-ink bg-paper px-2 py-1.5"
                value={displayName}
                maxLength={DISPLAY_NAME_MAX}
                onChange={(event) => setDisplayName(event.target.value)}
                aria-invalid={Boolean(errors.displayName)}
              />
              <Counter value={displayName} max={DISPLAY_NAME_MAX} />
              <FieldError message={errors.displayName} />
            </label>
          </>
        ) : (
          <label className="mb-3 block">
            <span className="text-md mb-1 block">Handle</span>
            <span className="flex items-stretch">
              <span className="text-md flex items-center border border-r-0 border-ink bg-well px-2 font-pixel">
                {HANDLE_RULES[platform as HandlePlatform].prefix}
              </span>
              <input
                type="text"
                className="text-lg w-full min-w-0 border border-ink bg-paper px-2 py-1.5"
                value={handle}
                maxLength={HANDLE_RULES[platform as HandlePlatform].maxLength}
                onChange={(event) => setHandle(event.target.value)}
                placeholder={HANDLE_RULES[platform as HandlePlatform].example}
                aria-invalid={Boolean(errors.handle)}
                aria-describedby="derived-url"
              />
            </span>
            <span id="derived-url" className="text-xs mt-1 block break-all text-ink-soft">
              {derivedUrl ? `Links to ${derivedUrl}` : "Links to the address shown above."}
            </span>
            <FieldError message={errors.handle} />
          </label>
        )}

        {embeddable && (
          <label className="mb-3 block">
            <span className="text-md mb-1 block">
              Link to a post <span className="text-ink-soft">(optional)</span>
            </span>
            <input
              type="url"
              inputMode="url"
              className="text-lg w-full border border-ink bg-paper px-2 py-1.5"
              value={postUrl}
              maxLength={2048}
              onChange={(event) => setPostUrl(event.target.value)}
              placeholder={POST_URL_EXAMPLE[platform as EmbeddablePlatform]}
              aria-invalid={Boolean(errors.postUrl)}
              aria-describedby="post-url-help"
            />
            <span id="post-url-help" className="text-xs mt-1 block text-ink-soft">
              Slot 01 shows the post itself. Slots 02 and 03 do not, so this only changes anything
              on the top slot.
            </span>
            <FieldError message={errors.postUrl} />
          </label>
        )}

        <label className="block">
          <span className="text-md mb-1 block">One line of copy</span>
          <input
            type="text"
            className="text-lg w-full border border-ink bg-paper px-2 py-1.5"
            value={tagline}
            maxLength={TAGLINE_MAX}
            onChange={(event) => setTagline(event.target.value)}
            aria-invalid={Boolean(errors.tagline)}
          />
          <Counter value={tagline} max={TAGLINE_MAX} />
          <FieldError message={errors.tagline} />
        </label>
      </fieldset>

      {errors.form && (
        <Plate surface="note" className="text-md mt-3 border-2 px-3 py-2 shadow-none" role="alert">
          {errors.form}
        </Plate>
      )}

      <BevelButton variant="navy" size="lg" className="mt-4" disabled={pending} onClick={submit}>
        {pending ? "CHECKING…" : "CONTINUE"}
      </BevelButton>
    </div>
  );
}
