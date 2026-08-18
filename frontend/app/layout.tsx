import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import { Waves } from "lucide-react";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "Blue Ocean — Find What Your City Is Missing",
  description:
    "Discover underserved industries, compare business supply across similar cities and uncover potential Blue Ocean opportunities using global open location data.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `document.documentElement.classList.add('dark')` }} />
      </head>
      <body className={`${inter.variable} font-sans dark`}>
        <ThemeProvider>
          <div className="flex min-h-screen flex-col">
            <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
              <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
                <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 via-violet-500 to-cyan-500 text-white shadow">
                    <Waves className="h-4 w-4" />
                  </span>
                  <span>
                    Blue Ocean <span className="hidden text-muted-foreground sm:inline">· Market Gap Intelligence</span>
                  </span>
                </Link>
                <div className="flex items-center gap-2">
                  <Link
                    href="/#methodology"
                    className="hidden rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:block"
                  >
                    Methodology
                  </Link>
                  <Link
                    href="/#explorer"
                    className="hidden rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:block"
                  >
                    Category Explorer
                  </Link>
                  <ThemeToggle />
                </div>
              </div>
            </header>
            <main className="flex-1">{children}</main>
            <footer className="border-t border-border/60 py-8">
              <div className="mx-auto max-w-7xl space-y-2 px-4 text-xs text-muted-foreground sm:px-6">
                <p>
                  Blue Ocean Opportunity Intelligence — built on{" "}
                  <a href="https://overturemaps.org" target="_blank" rel="noreferrer" className="underline hover:text-foreground">
                    Overture Maps
                  </a>
                  ,{" "}
                  <a href="https://www.wikidata.org" target="_blank" rel="noreferrer" className="underline hover:text-foreground">
                    Wikidata
                  </a>{" "}
                  and{" "}
                  <a href="https://www.openstreetmap.org" target="_blank" rel="noreferrer" className="underline hover:text-foreground">
                    OpenStreetMap
                  </a>
                  .
                </p>
                <p>
                  Estimated supply gaps are statistical market intelligence, not guaranteed demand. Scores are computed
                  deterministically from open data — no fabricated statistics.
                </p>
              </div>
            </footer>
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
