import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "AI Income Lab — Halal Business Discovery",
  description: "AI-assisted business opportunity discovery and execution system for generating legitimate, halal online income.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // SHELL NOTE: the console chrome (Sidebar + offset main) lives in
  // src/app/(admin)/layout.tsx so the PUBLIC storefront at /store renders
  // outside the admin console. Root stays minimal: html/body only.
  return (
    <html lang="en">
      <body className={`${inter.className} antialiased`}>
        {children}
      </body>
    </html>
  );
}
