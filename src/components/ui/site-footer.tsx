import Link from "next/link";

/**
 * The footer.
 *
 * It exists for one reason: the rules have to be reachable from every page,
 * because the forfeit on a takedown (decision D4) is stated there and a rule
 * that can only be found from the checkout receipt is one most people will never
 * have seen (#17).
 */
export function SiteFooter() {
  return (
    <footer className="text-md mt-6 flex flex-wrap gap-x-4 gap-y-1 text-paper">
      <Link href="/">The board</Link>
      <Link href="/checkout">Pay for time</Link>
      <Link href="/terms">The rules</Link>
    </footer>
  );
}
