import type { Metadata } from "next";
import { APP_NAME, APP_TAGLINE } from "@/lib/constants";
import "./globals.css";

/**
 * Root layout — a server component.
 *
 * It owns the document shell and metadata only. There is no
 * `'use client'` here: all interactivity lives in `app/page.tsx`
 * (frontend.md §'use client'). The `dark` class on `<html>` plus
 * the `html { @apply bg-zinc-950 }` rule in globals.css prevent a
 * white flash before hydration.
 */
export const metadata: Metadata = {
  title: `${APP_NAME} — ${APP_TAGLINE}`,
  description:
    "Deploy a full arithmetic grid ladder onto the Kuru CLOB on Monad Mainnet in a single parallel burst. Client-only — keys never leave the wallet.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
