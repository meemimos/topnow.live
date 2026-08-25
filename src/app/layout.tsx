import type { Metadata } from "next";

import "./globals.css";

// Silkscreen and Verdana are set up by #4 along with the rest of the type system.
export const metadata: Metadata = {
  title: "TopNow",
  description:
    "Rent the top spot. Three slots, rented by the hour. When the meter runs out, it's gone.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
