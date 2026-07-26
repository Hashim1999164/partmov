import type { Metadata } from "next";
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/** Loom Lens uses a soft product sans; Plus Jakarta Sans is the closest public match. */
const sans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-body",
  weight: ["400", "500", "600", "700"],
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: {
    default: "Partmov — a private cinema for two",
    template: "%s · Partmov",
  },
  description:
    "Partmov is a privacy-first, fully open-source co-watching platform: two people, one private room, server-authoritative playback sync with invisible drift correction.",
  openGraph: {
    title: "Partmov — a private cinema for two",
    description:
      "Product and system blueprint for a self-hostable, low-latency co-watching platform built entirely on open-source infrastructure.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      data-theme="dark"
      className={`${sans.variable} ${mono.variable}`}
    >
      <body>
        <noscript>
          <style>{`.reveal { opacity: 1 !important; transform: none !important; }`}</style>
        </noscript>
        {children}
      </body>
    </html>
  );
}
