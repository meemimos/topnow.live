import { notFound, redirect } from "next/navigation";

import { AdminSignIn } from "@/components/admin/sign-in";
import { currentAdmin } from "@/lib/admin/auth";
import { adminConfigured } from "@/lib/config/server";

export const dynamic = "force-dynamic";

export const metadata = { title: "TopNow admin", robots: { index: false, follow: false } };

/**
 * The sign-in page (#17).
 *
 * `notFound()` when the admin surface is not configured, exactly as the admin
 * page itself does. A deployment without admin credentials does not have a
 * half-built admin panel behind a form — it has no admin panel, and the 404 is
 * the honest description of that.
 */
export default async function AdminLoginPage() {
  if (!adminConfigured()) notFound();
  if (await currentAdmin()) redirect("/admin");

  return (
    <main className="mx-auto flex max-w-[420px] flex-col px-2 pt-8 pb-10">
      <AdminSignIn />
    </main>
  );
}
