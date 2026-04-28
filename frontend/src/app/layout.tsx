import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Aloqa",
  description: "Team communication — chat, calls, meetings.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full bg-app font-sans text-ink antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
