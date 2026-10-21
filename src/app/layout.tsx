import type { Metadata, Viewport } from "next";
import { Schibsted_Grotesk } from "next/font/google";
import "./globals.css";

const sans = Schibsted_Grotesk({ variable: "--font-sans", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "StreamOps", template: "%s · StreamOps" },
  description: "Show scheduling for the live-selling team.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#101b31",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${sans.variable} min-h-full`}>{children}</body>
    </html>
  );
}
