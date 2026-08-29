import type { Metadata } from "next";
import type { ReactNode } from "react";

const ORIGIN = "https://api.ripar.io";
const NAME = "Ripar Text Tools";
const PITCH =
  "A real, payable x402 endpoint on Algorand. Ask it to summarise text and it answers 402 with a price in USDC.";

/**
 * The metadata a facilitator actually reads.
 *
 * GoPlausible enriches a merchant's dashboard entry by scraping the root page
 * — og:site_name, then og:title, then <title> for the name; og:description or
 * the meta description for the blurb; og:image for the logo. None of it comes
 * from the x402 config, which is the part that surprises people: an agent can
 * be settling real payments and still show up nameless because nothing ever
 * served an HTML head at its domain root.
 *
 * This file exists for that scraper. metadataBase makes the relative
 * opengraph-image resolve to an absolute HTTPS URL, which the scraper requires.
 */
export const metadata: Metadata = {
  metadataBase: new URL(ORIGIN),
  title: NAME,
  description: PITCH,
  openGraph: {
    siteName: NAME,
    title: NAME,
    description: PITCH,
    url: ORIGIN,
    type: "website",
  },
  twitter: { card: "summary_large_image", title: NAME, description: PITCH },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
