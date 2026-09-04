import { z } from "zod";

/**
 * What a report submission has to be (#17).
 *
 * The report path is public and unauthenticated by design — requiring an account
 * to report an impersonation means the person being impersonated has to sign up
 * to say so. Everything here is therefore stranger-supplied text, and this file
 * is the boundary it stops at.
 */

export const REPORT_REASONS = ["impersonation", "malicious_link", "abusive_copy", "other"] as const;

export type ReportReasonValue = (typeof REPORT_REASONS)[number];

/** The label each reason carries, in the report dialog and in the admin queue. */
export const REPORT_REASON_LABELS: Record<ReportReasonValue, string> = {
  impersonation: "This is not their account",
  malicious_link: "The link is harmful",
  abusive_copy: "The wording is abusive",
  other: "Something else",
};

export const reportSchema = z.object({
  purchaseId: z.uuid({ error: "That listing id is not valid." }),

  reason: z.enum(REPORT_REASONS, { error: "Pick a reason." }),

  /**
   * Optional, and capped well below the column width. A report is a pointer to
   * something a human will then look at themselves; it is not the place to paste
   * a transcript, and an unbounded field on an unauthenticated endpoint is a
   * cheap way to fill a database.
   */
  detail: z
    .string()
    .trim()
    .max(1000, "Keep it under 1000 characters.")
    // `.optional()` last, so the inferred key is optional rather than required
    // and merely allowed to be undefined. An empty box and an absent field are
    // the same thing to a reporter and should be the same thing here.
    .transform((value) => (value.length > 0 ? value : undefined))
    .optional(),

  /**
   * Optional contact. The issue says optional and it stays optional: a reporter
   * who does not want to hear back should not have to invent an address, and a
   * required field here would mostly collect fake ones.
   */
  contact: z
    .string()
    .trim()
    .max(200, "Keep it under 200 characters.")
    .transform((value) => (value.length > 0 ? value : undefined))
    .optional(),
});

export type ReportInput = z.infer<typeof reportSchema>;

export function parseReport(input: unknown) {
  return reportSchema.safeParse(input);
}

/** The first message per field, in the shape the dialog renders. */
export function reportFieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path.join(".") || "form";
    errors[field] ??= issue.message;
  }
  return errors;
}
