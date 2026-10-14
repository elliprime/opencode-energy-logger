import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: 'Energy viewer',
  description: 'Analyze the energy records captured by opencode-energy-logger.',
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className="bg-zinc-50 text-zinc-900 antialiased">{children}</body>
    </html>
  );
}
