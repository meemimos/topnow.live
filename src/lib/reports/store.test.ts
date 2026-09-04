import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/lib/db";
import { quoteForQueue } from "@/lib/pricing";

import {
  closedReports,
  dismissReport,
  openReportCounts,
  openReports,
  reporterHash,
  submitReport,
} from "./store";

/**
 * Abuse reports (#17).
 *
 * A paid board that displays somebody else's identity needs a way for that
 * somebody to say so. These tests are mostly about the report path not becoming
 * the next problem: it must not remove anything by itself, it must not let one
 * person look like twenty, and it must not turn into a log of who complained.
 */

const db = getDb();

async function seedListing(handle = "mira-builds") {
  const quote = quoteForQueue(1, 3, 0);
  return db.purchase.create({
    data: {
      slot: 1,
      durationH: 3,
      handle,
      platform: "github",
      targetUrl: `https://github.com/${handle}`,
      tagline: "Open-source invoicing for freelancers who hate invoicing.",
      priceHrCents: quote.askHrCents,
      totalPaidCents: quote.totalCents,
      status: "queued",
    },
  });
}

beforeEach(async () => {
  await db.adminAction.deleteMany();
  await db.report.deleteMany();
  await db.purchase.deleteMany();
});

afterAll(async () => {
  await db.adminAction.deleteMany();
  await db.report.deleteMany();
  await db.purchase.deleteMany();
});

describe("reporterHash", () => {
  it("is the same for one address within a day", () => {
    const at = new Date("2026-09-04T02:00:00Z");
    const later = new Date("2026-09-04T22:00:00Z");
    expect(reporterHash("198.51.100.7", at)).toBe(reporterHash("198.51.100.7", later));
  });

  it("is unrelated across days", () => {
    // The same construction #15's counter uses: it answers "same reporter or a
    // different one" within a day and cannot be used to follow anyone past it.
    const monday = new Date("2026-09-04T12:00:00Z");
    const tuesday = new Date("2026-09-05T12:00:00Z");
    expect(reporterHash("198.51.100.7", monday)).not.toBe(reporterHash("198.51.100.7", tuesday));
  });

  it("never contains the address", () => {
    expect(reporterHash("198.51.100.7")).not.toContain("198.51.100.7");
    expect(reporterHash("198.51.100.7")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("submitReport", () => {
  it("records a report against a real listing", async () => {
    const listing = await seedListing();
    const outcome = await submitReport(
      { purchaseId: listing.id, reason: "impersonation", detail: "Not their account." },
      reporterHash("198.51.100.7"),
    );

    expect(outcome.kind).toBe("recorded");
    expect(await db.report.count()).toBe(1);
  });

  it("does not touch the listing", async () => {
    const listing = await seedListing();
    await submitReport(
      { purchaseId: listing.id, reason: "impersonation" },
      reporterHash("198.51.100.7"),
    );

    // A report is a pointer for a human. An endpoint that removed a paid listing
    // on a stranger's say-so would be a takedown button with no auth on it.
    const after = await db.purchase.findUniqueOrThrow({ where: { id: listing.id } });
    expect(after.status).toBe("queued");
    expect(after.killedAt).toBeNull();
  });

  it("refuses a listing that does not exist", async () => {
    const outcome = await submitReport(
      { purchaseId: "00000000-0000-4000-8000-000000000000", reason: "other" },
      reporterHash("198.51.100.7"),
    );
    expect(outcome.kind).toBe("unknown-listing");
  });

  it("counts one person twice as one report", async () => {
    const listing = await seedListing();
    const hash = reporterHash("198.51.100.7");

    expect((await submitReport({ purchaseId: listing.id, reason: "other" }, hash)).kind).toBe(
      "recorded",
    );
    // A queue where one upset person can make a listing look like it has twenty
    // complaints is a queue that mis-sorts the real ones.
    expect((await submitReport({ purchaseId: listing.id, reason: "other" }, hash)).kind).toBe(
      "duplicate",
    );
    expect(await db.report.count()).toBe(1);
  });

  it("counts two people as two reports", async () => {
    const listing = await seedListing();
    await submitReport({ purchaseId: listing.id, reason: "other" }, reporterHash("198.51.100.7"));
    await submitReport({ purchaseId: listing.id, reason: "other" }, reporterHash("203.0.113.9"));
    expect(await db.report.count()).toBe(2);
  });

  it("lets the same person report a different listing", async () => {
    const first = await seedListing("mira-builds");
    const second = await seedListing("parcelkit");
    const hash = reporterHash("198.51.100.7");

    await submitReport({ purchaseId: first.id, reason: "other" }, hash);
    expect((await submitReport({ purchaseId: second.id, reason: "other" }, hash)).kind).toBe(
      "recorded",
    );
  });
});

describe("the queue a human works through", () => {
  it("lists open reports oldest first", async () => {
    const first = await seedListing("mira-builds");
    const second = await seedListing("parcelkit");

    await submitReport(
      { purchaseId: second.id, reason: "other" },
      reporterHash("203.0.113.9"),
      new Date("2026-09-04T09:00:00Z"),
    );
    await submitReport(
      { purchaseId: first.id, reason: "other" },
      reporterHash("198.51.100.7"),
      new Date("2026-09-04T08:00:00Z"),
    );

    // Oldest first, because oldest has waited longest.
    const queue = await openReports();
    expect(queue.map((row) => row.purchase.handle)).toEqual(["mira-builds", "parcelkit"]);
  });

  it("counts open reports per listing", async () => {
    const listing = await seedListing();
    await submitReport({ purchaseId: listing.id, reason: "other" }, reporterHash("198.51.100.7"));
    await submitReport({ purchaseId: listing.id, reason: "other" }, reporterHash("203.0.113.9"));

    expect((await openReportCounts([listing.id])).get(listing.id)).toBe(2);
  });
});

describe("dismissReport", () => {
  it("closes the report and leaves the listing alone", async () => {
    const listing = await seedListing();
    const { report } = (await submitReport(
      { purchaseId: listing.id, reason: "other" },
      reporterHash("198.51.100.7"),
    )) as { report: { id: string } };

    await dismissReport(report.id, { actor: "ops", reason: "Checked; it is their account." });

    expect((await db.report.findUniqueOrThrow({ where: { id: report.id } })).status).toBe(
      "dismissed",
    );
    expect((await db.purchase.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe(
      "queued",
    );
  });

  it("audits the decision", async () => {
    const listing = await seedListing();
    const { report } = (await submitReport(
      { purchaseId: listing.id, reason: "other" },
      reporterHash("198.51.100.7"),
    )) as { report: { id: string } };

    await dismissReport(report.id, { actor: "ops", reason: "Checked; it is their account." });

    // Deciding a listing stays is a decision, and the record of who made it is
    // worth the same as the record of a takedown.
    const [entry] = await db.adminAction.findMany();
    expect(entry).toMatchObject({
      kind: "dismiss",
      actor: "ops",
      reportId: report.id,
      reason: "Checked; it is their account.",
    });
  });

  it("keeps a closed report rather than deleting it", async () => {
    const listing = await seedListing();
    const { report } = (await submitReport(
      { purchaseId: listing.id, reason: "other" },
      reporterHash("198.51.100.7"),
    )) as { report: { id: string } };
    await dismissReport(report.id, { actor: "ops", reason: "no case" });

    // A pattern of dismissed reports about one account is itself information.
    expect(await closedReports()).toHaveLength(1);
    expect(await openReports()).toHaveLength(0);
  });

  it("produces one decision when two admins click at once", async () => {
    const listing = await seedListing();
    const { report } = (await submitReport(
      { purchaseId: listing.id, reason: "other" },
      reporterHash("198.51.100.7"),
    )) as { report: { id: string } };

    const [first, second] = await Promise.all([
      dismissReport(report.id, { actor: "ops", reason: "first" }),
      dismissReport(report.id, { actor: "other", reason: "second" }),
    ]);

    // One of them wrote the decision; the other must not have rewritten it, and
    // must not have added a second audit record for a decision already made.
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await db.adminAction.count()).toBe(1);
  });

  it("returns null for a report that does not exist", async () => {
    expect(
      await dismissReport("00000000-0000-4000-8000-000000000000", {
        actor: "ops",
        reason: "nothing here",
      }),
    ).toBeNull();
  });
});
