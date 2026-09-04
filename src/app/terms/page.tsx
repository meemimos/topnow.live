import { Plate } from "@/components/ui/plate";
import { SiteFooter } from "@/components/ui/site-footer";
import { TitleBar } from "@/components/ui/title-bar";
import { QUEUE_CAP_HOURS } from "@/lib/pricing";

export const metadata = {
  title: "TopNow — the rules",
  description: "What you are buying, what you may list, and what happens if a listing comes down.",
};

/**
 * The rules (#17).
 *
 * Required by the issue as the place the refund policy is stated up front. It is
 * written as plain product copy rather than as legal boilerplate, on the
 * argument that a rule somebody actually reads is worth more than one that is
 * technically enforceable and universally skipped.
 *
 * The single clause this page exists for is the forfeit (decision D4): a listing
 * taken down is not refunded. That is stated here, and again on the receipt
 * before payment, because it must not be something a person discovers at the
 * moment it costs them.
 */

function Rule({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="mt-4 first:mt-0">
      <h2 className="text-lg mt-0 mb-1 font-bold">{heading}</h2>
      <div className="text-md leading-[1.7] [&>p]:mt-0 [&>p]:mb-2 [&>p:last-child]:mb-0">
        {children}
      </div>
    </section>
  );
}

export default function TermsPage() {
  return (
    <main className="mx-auto flex max-w-[720px] flex-col px-2 pt-4 pb-10">
      <h1 className="text-2xl mt-0 mb-3 font-bold text-paper">The rules</h1>

      <Plate className="p-[3px]">
        <TitleBar>WHAT YOU ARE BUYING</TitleBar>
        <div className="bg-paper px-3 py-3.5">
          <Rule heading="Time, not a place">
            <p>
              A slot is rented by the hour. Nobody can outbid you off it and nobody can extend past
              their hours. When the meter reaches zero the slot reopens at base price and the next
              listing in the queue goes up.
            </p>
            <p>
              The rate is locked at checkout. If the slot gets busier after you buy, you pay what
              you were quoted.
            </p>
          </Rule>

          <Rule heading="The queue">
            <p>
              If a slot is occupied you join a queue and go live when the listings ahead of you run
              out. A slot stops taking bookings once the wait passes {QUEUE_CAP_HOURS} hours, so the
              queue cannot be sold further ahead than that.
            </p>
          </Rule>

          <Rule heading="What you may list">
            <p>
              An account you control, or a website you are responsible for. Not somebody
              else&rsquo;s identity, not a link that harms whoever follows it, and not copy written
              to abuse a person.
            </p>
            <p>
              Nothing at checkout can prove you own a handle, so this is enforced after the fact
              rather than at the door — see below.
            </p>
          </Rule>

          <Rule heading="Reporting a listing">
            <p>
              Every listing on the board carries a report control. No account is needed to use it:
              requiring one would mean the person being impersonated has to sign up in order to say
              so.
            </p>
            <p>
              A report is read by a person. Nothing is removed automatically, and nothing is removed
              because a report exists.
            </p>
          </Rule>

          <Rule heading="Takedowns, and the refund">
            <p>
              A listing that breaks the rules above is removed from the board. The slot is freed
              immediately and passes to whoever is next in the queue.
            </p>
            <p>
              <strong>
                The time remaining on a removed listing is forfeited. There is no refund, full or
                partial.
              </strong>{" "}
              That is stated here and again on the receipt before you pay, because it is not
              something anybody should find out at the moment it applies.
            </p>
            <p>
              A removed listing stays in the ledger, marked as taken down. The tape is a record of
              what happened, and it is not rewritten.
            </p>
          </Rule>

          <Rule heading="The numbers on this page">
            <p>
              Every figure on TopNow is measured or it is absent. Clicks are counted by TopNow when
              somebody follows a listing&rsquo;s link. Visitor counts come from real page renders.
              Prices come from real purchases, and the chart is drawn from hourly samples of the
              asking rate.
            </p>
            <p>
              Nothing is seeded, padded, replayed or rounded up. A quiet hour looks quiet, which is
              the point.
            </p>
          </Rule>
        </div>
      </Plate>
      <SiteFooter />
    </main>
  );
}
