import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Taurus — Prompt-driven investing",
  description:
    "Taurus is a prompt-driven investing dashboard. Describe a thesis in plain English and Taurus builds a custom basket of stocks you can paper-trade.",
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetBrainsMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
