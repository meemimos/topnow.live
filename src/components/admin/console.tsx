"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { BevelButton } from "@/components/ui/bevel-button";
import { Plate } from "@/components/ui/plate";
import { TitleBar } from "@/components/ui/title-bar";
import { REPORT_REASON_LABELS, type ReportReasonValue } from "@/lib/reports/schema";

/**
 * The admin console (#17).
 *
 * Three surfaces, in the order the work happens: reports waiting on a decision,
 * everything currently on the board or in a queue, and the audit trail.
 *
 * ## Every decision asks for a reason
 *
 * Both buttons are disabled until one is typed — for taking a listing down *and*
 * for leaving it up. The audit trail's value is that each entry answers who,
 * when, what and why, and a form that lets the "why" be skipped produces the
 * entry that is useless in the one conversation it exists for.
 *
 * ## No bulk actions
 *
 * Deliberately. Each of these takes money's worth of somebody's time off a
 * public board with no refund (D4); a "select all" is how that gets done without
 * reading.
 */

export type ReportRow = {
  id: string;
  purchaseId: string;
  reason: ReportReasonValue;
  detail: string | null;
  contact: string | null;
  createdAtMs: number;
  listing: { name: string; slot: number; status: string; tagline: string; targetUrl: string };
  /** Distinct reporters for this listing today, which is not the same as reports. */
  reportsOnListing: number;
};

export type ListingRow = {
  id: string;
  name: string;
  slot: number;
  status: string;
  tagline: string;
  targetUrl: string;
  openReports: number;
};

export type AuditRow = {
  id: string;
  kind: "kill" | "dismiss";
  actor: string;
  reason: string;
  createdAtMs: number;
  subject: string | null;
};

function when(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

/** A reason box and the buttons it gates. */
function Decision({
  actions,
  busy,
  onRun,
}: {
  actions: { label: string; kind: "kill" | "dismiss"; variant?: "navy" }[];
  busy: boolean;
  onRun: (kind: "kill" | "dismiss", reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const ready = reason.trim().length > 0 && !busy;
  // One of these renders per report and per listing, so the id has to be unique
  // per instance — a repeated `for` would point every label at the first box.
  const id = useId();

  return (
    <div className="mt-2">
      <label className="text-2xs mb-1 block font-pixel text-ink-soft" htmlFor={id}>
        WHY — recorded against your name
      </label>
      <input
        id={id}
        className="text-md mb-2 block w-full border border-ink bg-well p-2"
        maxLength={500}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <BevelButton
            key={action.kind}
            size="sm"
            variant={action.variant}
            disabled={!ready}
            onClick={() => onRun(action.kind, reason.trim())}
          >
            {action.label}
          </BevelButton>
        ))}
      </div>
    </div>
  );
}

export function AdminConsole({
  admin,
  reports,
  listings,
  audit,
}: {
  admin: string;
  reports: ReportRow[];
  listings: ListingRow[];
  audit: AuditRow[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run(path: string, body: object) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const parsed = (await response.json().catch(() => null)) as { message?: string } | null;

      if (!response.ok) {
        setMessage(parsed?.message ?? "That did not go through.");
        return;
      }
      router.refresh();
    } catch {
      setMessage("The connection failed.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await fetch("/api/admin/session", { method: "DELETE" });
    router.push("/");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <Plate className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <span className="text-md">
          Signed in as <span className="font-bold">{admin}</span>
        </span>
        <BevelButton size="sm" onClick={signOut}>
          SIGN OUT
        </BevelButton>
      </Plate>

      {message && (
        <Plate surface="note" className="text-md border-2 px-3 py-2 shadow-none" role="alert">
          {message}
        </Plate>
      )}

      <Plate className="p-[3px]">
        <TitleBar meta={`${reports.length} WAITING`}>REPORTS</TitleBar>
        <div className="bg-paper p-3">
          {reports.length === 0 ? (
            <p className="text-md m-0 text-ink-soft">Nothing reported. This is the usual state.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {reports.map((report) => (
                <li key={report.id}>
                  <Plate variant="inset" surface="paper" className="p-3">
                    <div className="text-md flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-bold break-all">
                        slot {String(report.listing.slot).padStart(2, "0")} — {report.listing.name}
                      </span>
                      <span className="text-2xs font-pixel text-ink-soft" data-numeric>
                        {when(report.createdAtMs)}
                      </span>
                    </div>

                    <p className="text-md mt-1 mb-0">
                      <span className="font-bold">{REPORT_REASON_LABELS[report.reason]}</span>
                      {report.reportsOnListing > 1 && (
                        <span className="text-ink-soft">
                          {" "}
                          — {report.reportsOnListing} open reports on this listing
                        </span>
                      )}
                    </p>

                    {/* Reporter-written text. Rendered as text, never as markup,
                        and never shown on the public board. */}
                    {report.detail && (
                      <p className="text-md mt-1.5 mb-0 leading-[1.6] break-words whitespace-pre-wrap">
                        {report.detail}
                      </p>
                    )}
                    {report.contact && (
                      <p className="text-2xs mt-1.5 mb-0 text-ink-soft break-all">
                        contact: {report.contact}
                      </p>
                    )}

                    <p className="text-2xs mt-2 mb-0 text-ink-soft break-all">
                      {report.listing.tagline} · {report.listing.targetUrl} ·{" "}
                      {report.listing.status}
                    </p>

                    <Decision
                      busy={busy}
                      actions={[
                        { label: "TAKE IT DOWN", kind: "kill", variant: "navy" },
                        { label: "LEAVE IT UP", kind: "dismiss" },
                      ]}
                      onRun={(kind, reason) =>
                        kind === "kill"
                          ? run("/api/admin/kill", {
                              purchaseId: report.purchaseId,
                              reportId: report.id,
                              reason,
                            })
                          : run("/api/admin/dismiss", { reportId: report.id, reason })
                      }
                    />
                  </Plate>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Plate>

      <Plate className="p-[3px]">
        <TitleBar>LIVE AND QUEUED</TitleBar>
        <div className="bg-paper p-3">
          {listings.length === 0 ? (
            <p className="text-md m-0 text-ink-soft">Nothing on the board and nothing waiting.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {listings.map((listing) => (
                <li key={listing.id}>
                  <Plate variant="inset" surface="paper" className="p-3">
                    <div className="text-md font-bold break-all">
                      slot {String(listing.slot).padStart(2, "0")} — {listing.name}{" "}
                      <span className="text-2xs font-pixel text-ink-soft">{listing.status}</span>
                      {listing.openReports > 0 && (
                        <span className="text-2xs ml-1 font-pixel text-ink-soft">
                          · {listing.openReports} open{" "}
                          {listing.openReports === 1 ? "report" : "reports"}
                        </span>
                      )}
                    </div>
                    <p className="text-2xs mt-1 mb-0 text-ink-soft break-all">
                      {listing.tagline} · {listing.targetUrl}
                    </p>
                    {/* An admin can act on what they see. A takedown does not
                        require somebody to have reported it first. */}
                    <Decision
                      busy={busy}
                      actions={[{ label: "TAKE IT DOWN", kind: "kill", variant: "navy" }]}
                      onRun={(_kind, reason) =>
                        run("/api/admin/kill", { purchaseId: listing.id, reason })
                      }
                    />
                  </Plate>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Plate>

      <Plate className="p-[3px]">
        <TitleBar>AUDIT TRAIL</TitleBar>
        <div className="bg-paper p-3">
          {audit.length === 0 ? (
            <p className="text-md m-0 text-ink-soft">No admin action has ever been taken.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {audit.map((entry) => (
                <li key={entry.id} className="text-md leading-[1.6] break-words">
                  <span className="text-2xs font-pixel text-ink-soft" data-numeric>
                    {when(entry.createdAtMs)}
                  </span>{" "}
                  <span className="font-bold">{entry.actor}</span>{" "}
                  {entry.kind === "kill" ? "took down" : "left up"}{" "}
                  <span className="font-bold break-all">{entry.subject ?? "a listing"}</span> —{" "}
                  {entry.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Plate>
    </div>
  );
}
