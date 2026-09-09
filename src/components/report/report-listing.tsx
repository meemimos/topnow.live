"use client";

import { useState } from "react";

import { BevelButton } from "@/components/ui/bevel-button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Plate } from "@/components/ui/plate";
import { REPORT_REASONS, REPORT_REASON_LABELS, type ReportReasonValue } from "@/lib/reports/schema";

/**
 * The report control (#17).
 *
 * ## Why it is on every listing rather than in a footer
 *
 * The report is about *a listing*, and a form that starts with "which listing?"
 * is a form nobody completes. Opening it from the listing means the id is
 * already known and the person reporting only has to say what is wrong.
 *
 * ## Why it is quiet
 *
 * It sits at the bottom of the card in small type. Loud enough to find when
 * something is wrong, quiet enough not to read as an invitation — a prominent
 * REPORT button next to a paid listing suggests the board expects its listings
 * to be reportable, which is both untrue and unfair to the person who paid.
 *
 * It is a real `<button>` inside a Radix dialog, so it is in the tab order, has
 * the focus ring every other control has, traps focus while open and returns it
 * on close. "Reachable by keyboard" is an acceptance line on this issue and it
 * is not something to reimplement by hand.
 */

type State =
  | { kind: "editing" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "refused"; message: string };

export function ReportListing({ purchaseId, name }: { purchaseId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReasonValue>("impersonation");
  const [detail, setDetail] = useState("");
  const [contact, setContact] = useState("");
  const [state, setState] = useState<State>({ kind: "editing" });

  function reset() {
    setState({ kind: "editing" });
    setReason("impersonation");
    setDetail("");
    setContact("");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setState({ kind: "sending" });

    try {
      const response = await fetch("/api/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          purchaseId,
          reason,
          ...(detail.trim() ? { detail: detail.trim() } : {}),
          ...(contact.trim() ? { contact: contact.trim() } : {}),
        }),
      });

      if (response.ok) {
        setState({ kind: "sent" });
        return;
      }

      // The 429 body carries copy written for a person (#18). Everything else
      // gets a sentence that says what to do next rather than a status code.
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      setState({
        kind: "refused",
        message:
          body?.message ?? "That report did not go through. Check the details and try once more.",
      });
    } catch {
      setState({
        kind: "refused",
        message: "That report did not go through — the connection failed. Try once more.",
      });
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          className="text-2xs cursor-pointer border-0 bg-transparent p-0 font-pixel text-ink-soft underline underline-offset-2"
          data-report-trigger
        >
          report this listing
        </button>
      </DialogTrigger>

      <DialogContent
        title="REPORT A LISTING"
        description={`Report the listing for ${name} to the people who run TopNow.`}
      >
        {state.kind === "sent" ? (
          <div>
            <p className="text-base m-0 leading-[1.7]">
              Thank you — that is on file. A person reads every report. If the listing breaks the
              rules it comes off the board and the slot passes to whoever is next in the queue.
            </p>
            <p className="text-md mt-3 mb-0 text-ink-soft leading-[1.7]">
              Nothing is removed automatically, and nothing is removed because a report exists.
            </p>
            <BevelButton className="mt-4" onClick={() => setOpen(false)}>
              CLOSE
            </BevelButton>
          </div>
        ) : (
          <form onSubmit={submit}>
            <p className="text-md m-0 mb-3 leading-[1.7]">
              Reporting <span className="font-bold break-all">{name}</span>. No account needed.
            </p>

            <fieldset className="mb-4 border-0 p-0">
              <legend className="text-md mb-1.5 font-bold">What is wrong?</legend>
              <div className="flex flex-col gap-1.5">
                {REPORT_REASONS.map((value) => (
                  <label key={value} className="text-md flex items-center gap-2">
                    <input
                      type="radio"
                      name="reason"
                      value={value}
                      checked={reason === value}
                      onChange={() => setReason(value)}
                    />
                    {REPORT_REASON_LABELS[value]}
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="text-md mb-1 block font-bold" htmlFor="report-detail">
              Anything that would help (optional)
            </label>
            <textarea
              id="report-detail"
              className="text-md mb-3 block w-full border border-ink bg-well p-2"
              rows={3}
              maxLength={1000}
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
            />

            <label className="text-md mb-1 block font-bold" htmlFor="report-contact">
              How to reach you (optional)
            </label>
            <input
              id="report-contact"
              className="text-md mb-1 block w-full border border-ink bg-well p-2"
              maxLength={200}
              value={contact}
              onChange={(event) => setContact(event.target.value)}
            />
            <p className="text-2xs mt-0 mb-4 text-ink-soft leading-[1.6]">
              Only used to tell you what happened. Leave it blank and the report still counts.
            </p>

            {state.kind === "refused" && (
              <Plate
                surface="note"
                className="text-md mb-3 border-2 px-3 py-2 shadow-none"
                role="alert"
              >
                {state.message}
              </Plate>
            )}

            <BevelButton variant="navy" type="submit" disabled={state.kind === "sending"}>
              {state.kind === "sending" ? "SENDING..." : "SEND REPORT"}
            </BevelButton>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
