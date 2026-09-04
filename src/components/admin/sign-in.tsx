"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { BevelButton } from "@/components/ui/bevel-button";
import { Plate } from "@/components/ui/plate";
import { TitleBar } from "@/components/ui/title-bar";

/**
 * The admin sign-in form (#17).
 *
 * Posts to `/api/admin/session` rather than calling a server action, so that the
 * rate limit on authentication attempts can answer with a real `429` and a real
 * `Retry-After` (#18) — a server action has no status line to put them on. The
 * body of that 429 carries copy written for a person, and this renders it in the
 * product's own error treatment rather than letting the browser show a status
 * page.
 *
 * This one form needs JavaScript. The rest of the product does not, and that is
 * deliberate; a five-person admin panel is where the trade is worth making and
 * the board is not.
 */
export function AdminSignIn() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setMessage(null);

    try {
      const response = await fetch("/api/admin/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (response.ok) {
        // `refresh` as well as `push`: the session cookie was set by the
        // response above, and the admin page is server rendered from it — a push
        // alone can serve a cached render made while nobody was signed in.
        router.push("/admin");
        router.refresh();
        return;
      }

      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      setMessage(body?.message ?? "That is not a valid sign-in.");
    } catch {
      setMessage("The connection failed. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Plate className="p-[3px]">
      <TitleBar>ADMIN</TitleBar>
      <form className="bg-paper p-3" onSubmit={submit}>
        <label className="text-md mb-1 block font-bold" htmlFor="admin-username">
          Username
        </label>
        <input
          id="admin-username"
          name="username"
          autoComplete="username"
          className="text-md mb-3 block w-full border border-ink bg-well p-2"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />

        <label className="text-md mb-1 block font-bold" htmlFor="admin-password">
          Password
        </label>
        <input
          id="admin-password"
          name="password"
          type="password"
          autoComplete="current-password"
          className="text-md mb-3 block w-full border border-ink bg-well p-2"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        {message && (
          <Plate
            surface="note"
            className="text-md mb-3 border-2 px-3 py-2 shadow-none"
            role="alert"
            data-admin-error
          >
            {message}
          </Plate>
        )}

        <BevelButton variant="navy" type="submit" disabled={pending}>
          {pending ? "CHECKING..." : "SIGN IN"}
        </BevelButton>
      </form>
    </Plate>
  );
}
