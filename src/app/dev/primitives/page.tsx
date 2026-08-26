import type { Metadata } from "next";

import { CompactMeter, Meter } from "@/components/board/meter";
import { ServerClockProvider } from "@/components/clock/provider";
import { BevelButton } from "@/components/ui/bevel-button";
import { actionLabel, derivation, formatMoney, lineItem } from "@/lib/pricing/format";
import { quoteForQueue } from "@/lib/pricing";
import { serverNow } from "@/lib/time/server";
import { Plate, VacantPlate } from "@/components/ui/plate";
import { TitleBar } from "@/components/ui/title-bar";

export const metadata: Metadata = {
  title: "Primitives — TopNow",
  robots: { index: false, follow: false },
};

// The meter below is measured from the server's clock at request time. Left
// static, Date.now() would be frozen at build time and the demo would drift.
export const dynamic = "force-dynamic";

/**
 * Kitchen sink for #4. Every primitive in every state, so a change to the token
 * layer is visible in one place rather than found later on a real screen.
 */

const SWATCHES: Array<{ group: string; tokens: Array<[string, string]> }> = [
  {
    group: "Surfaces",
    tokens: [
      ["ground", "bg-ground"],
      ["plate", "bg-plate"],
      ["well", "bg-well"],
      ["well-alt", "bg-well-alt"],
      ["paper", "bg-paper"],
      ["note", "bg-note"],
      ["vacant", "bg-vacant"],
      ["ink-plate", "bg-ink-plate"],
    ],
  },
  {
    group: "Ink and rules",
    tokens: [
      ["ink", "bg-ink"],
      ["ink-soft", "bg-ink-soft"],
      ["ink-faint", "bg-ink-faint"],
      ["rule", "bg-rule"],
      ["plate-dark", "bg-plate-dark"],
      ["plate-light", "bg-plate-light"],
    ],
  },
  {
    group: "Navy",
    tokens: [
      ["navy", "bg-navy"],
      ["navy-light", "bg-navy-light"],
      ["navy-dark", "bg-navy-dark"],
      ["navy-ink", "bg-navy-ink"],
    ],
  },
  {
    group: "Meter — time, never price",
    tokens: [
      ["meter", "bg-meter"],
      ["meter-bright", "bg-meter-bright"],
      ["meter-dim", "bg-meter-dim"],
      ["meter-ground", "bg-meter-ground"],
    ],
  },
  {
    group: "Chart only — direction, never anything else",
    tokens: [
      ["up", "bg-up"],
      ["down", "bg-down"],
    ],
  },
];

const TYPE_SCALE: Array<[string, string]> = [
  ["2xs / 8px", "text-2xs"],
  ["xs / 9px", "text-xs"],
  ["sm / 10px", "text-sm"],
  ["base / 11px", "text-base"],
  ["md / 12px", "text-md"],
  ["lg / 13px", "text-lg"],
  ["xl / 14px", "text-xl"],
  ["2xl / 17px", "text-2xl"],
  ["3xl / 26px", "text-3xl"],
];

function Section({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <Plate className="mb-3 p-[3px]">
      <TitleBar meta={meta}>{title}</TitleBar>
      <div className="bg-paper p-3">{children}</div>
    </Plate>
  );
}

export default function PrimitivesPage() {
  // Derived, not typed in. The kitchen sink is subject to the same rule as every
  // other surface: no price is written down outside the pricing engine (#2).
  // 12 queued hours is the prototype's own queue depth on slot 01.
  const sample = quoteForQueue(1, 3, 12);
  const sampleAction = actionLabel(sample, false);

  // A live meter needs a real window. Two hours and change into a six-hour
  // rental, measured from the server's clock like every countdown in the app.
  const now = serverNow();
  const sampleEndsAt = new Date(now + 2 * 3_600_000 + 47 * 60_000 + 12_000);

  return (
    <main className="mx-auto flex max-w-[1020px] flex-col px-2 py-3">
      <Plate className="mb-3 p-[3px]">
        <TitleBar meta="ISSUE #4">TOPNOW PRIMITIVES</TitleBar>
        <div className="bg-paper p-3 text-lg">
          <p className="m-0">
            Every primitive and token in one place. Not linked from the app and not indexed.
          </p>
        </div>
      </Plate>

      <Section title="COLOUR TOKENS" meta="NO RAW HEX IN COMPONENTS">
        {SWATCHES.map(({ group, tokens }) => (
          <div key={group} className="mb-3 last:mb-0">
            <div className="mb-1 font-pixel text-sm font-bold">{group}</div>
            <div className="flex flex-wrap gap-2">
              {tokens.map(([name, className]) => (
                <div key={name} className="w-[104px]">
                  <div className={`h-10 border border-ink ${className}`} />
                  <div className="mt-1 font-pixel text-2xs">{name}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </Section>

      <Section title="TYPE" meta="TWO FAMILIES, NOTHING ELSE">
        <div className="mb-3">
          <div className="mb-1 font-pixel text-sm font-bold">
            Silkscreen — labels, numerals, buttons
          </div>
          {TYPE_SCALE.map(([label, className]) => (
            <div key={label} className={`font-pixel ${className}`}>
              {label} — {sampleAction}
            </div>
          ))}
        </div>
        <div>
          <div className="mb-1 font-pixel text-sm font-bold">Verdana — prose</div>
          <p className="m-0 text-lg">
            Three slots, rented by the hour. Nobody outbids you and nobody keeps it. When the clock
            hits zero the slot reopens at base price.
          </p>
        </div>
      </Section>

      <Section title="PLATE" meta="2PX BEVEL">
        <div className="flex flex-wrap gap-3">
          <Plate className="p-3 font-pixel text-base">raised</Plate>
          <Plate variant="inset" className="p-3 font-pixel text-base">
            inset
          </Plate>
          <Plate variant="float" className="p-3 font-pixel text-base">
            float
          </Plate>
          <Plate surface="paper" className="p-3 font-pixel text-base">
            surface=paper
          </Plate>
          <Plate surface="note" className="p-3 font-pixel text-base">
            surface=note
          </Plate>
          <VacantPlate className="p-3 font-pixel text-base">vacant — open at base</VacantPlate>
        </div>
      </Section>

      <Section title="TITLEBAR" meta="RIGHT-ALIGNED META">
        <div className="flex flex-col gap-3">
          <Plate className="p-[3px]">
            <TitleBar meta="PAID THROUGH 7:39 PM">SLOT 01</TitleBar>
            <div className="bg-paper p-2 text-lg">navy tone — panel headers</div>
          </Plate>
          <Plate className="p-[3px]">
            <TitleBar tone="well" meta="12 PURCHASES">
              QUEUED → LIVE → ENDED
            </TitleBar>
            <div className="bg-paper p-2 text-lg">well tone — section strips inside a plate</div>
          </Plate>
          <Plate className="p-[3px]">
            <TitleBar>NO META</TitleBar>
          </Plate>
        </div>
      </Section>

      <Section title="BEVELBUTTON" meta="INVERTS ON :ACTIVE">
        <div className="mb-3">
          <div className="mb-1 font-pixel text-sm font-bold">Silver</div>
          <div className="flex flex-wrap items-center gap-2">
            <BevelButton size="sm">SM</BevelButton>
            <BevelButton>MD</BevelButton>
            <BevelButton disabled>DISABLED</BevelButton>
          </div>
        </div>
        <div className="mb-3">
          <div className="mb-1 font-pixel text-sm font-bold">Navy — primary</div>
          <div className="flex flex-wrap items-center gap-2">
            <BevelButton variant="navy" size="sm">
              SM
            </BevelButton>
            <BevelButton variant="navy">MD</BevelButton>
            <BevelButton variant="navy" disabled>
              DISABLED
            </BevelButton>
          </div>
        </div>
        <div className="mb-3">
          <div className="mb-1 font-pixel text-sm font-bold">
            Toggles — selected holds the pressed bevel
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <BevelButton size="sm" selected>
              ALL
            </BevelButton>
            <BevelButton size="sm" selected={false}>
              01
            </BevelButton>
            <BevelButton size="sm" selected={false}>
              02
            </BevelButton>
            <BevelButton size="sm" selected={false}>
              03
            </BevelButton>
          </div>
        </div>
        <div>
          <div className="mb-1 font-pixel text-sm font-bold">
            Large &mdash; the panel&rsquo;s primary action
          </div>
          <BevelButton variant="navy" size="lg">
            {sampleAction}
          </BevelButton>
          <div className="mt-2 font-pixel text-2xs text-ink-soft">
            {lineItem(sample)} · {derivation(sample)} · {formatMoney(sample.totalCents)}
          </div>
        </div>
      </Section>

      <Section title="METER" meta="AMBER IS TIME">
        {/* Live, and ticking against the server clock — the real component (#7). */}
        <ServerClockProvider serverNow={now}>
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-[262px] flex-1">
              <Meter endsAt={sampleEndsAt} durationH={6} />
            </div>
            <div>
              <div className="mb-1 font-pixel text-sm font-bold">Compact — slots 02 and 03</div>
              <CompactMeter endsAt={sampleEndsAt} />
            </div>
          </div>
        </ServerClockProvider>
        <p className="mt-2 mb-0 text-md text-ink-soft">
          A rental about to expire does not turn red. Urgency is the size of the digits. The seconds
          tick brighter because they are the only thing moving.
        </p>
      </Section>

      <Section title="FOCUS" meta="KEYBOARD ONLY">
        <p className="mt-0 text-md text-ink-soft">
          Tab through the buttons above. The ring is amber, not navy — navy on a navy primary button
          is invisible, and the primary is the control that most needs a visible ring.
        </p>
      </Section>
    </main>
  );
}
