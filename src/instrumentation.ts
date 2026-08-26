import { serverConfig } from "@/lib/config/server";

/**
 * Next.js calls this once when the server starts.
 *
 * Validating here means a misconfigured deployment fails immediately and names
 * the offending variable, rather than throwing on whichever request first needs
 * a value that was never set.
 */
export async function register() {
  // The Edge runtime has no access to the server env; it is validated in the
  // Node.js runtime only, which is where every route that reads config runs.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  serverConfig();
}
