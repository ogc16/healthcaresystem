import type { Metadata } from "next";
import "./globals.css";
import { Plus_Jakarta_Sans as FontSans } from "next/font/google";

import { cn } from "@/lib/utils";

const fontSans = FontSans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "CarePulse",
  description:
    "A healthcare patient management System designed to streamline patient registration, appointment scheduling, and medical records management for healthcare providers.",
  icons: {
    icon: "/assets/icons/logo-icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // colorScheme is set statically rather than by a theme provider. It is the
    // one genuinely useful thing the provider did here: it keeps native
    // scrollbars, date pickers and form controls dark to match the design.
    //
    // next-themes also injected class="dark"/"light" and color-scheme from
    // localStorage, which made <html> the single source of hydration mismatches.
    // Nothing consumed that class: globals.css has no .light or .dark rules, and
    // there are no dark: or light: variants anywhere in the app, so the
    // provider only produced a pre-hydration script and a warning. The palette
    // is hardcoded dark per component, so there is no theme to switch.
    <html lang="en" style={{ colorScheme: "dark" }}>
      <body
        className={cn(
          "min-h-screen bg-dark-300 font-sans antialiased",
          fontSans.variable
        )}
      >
        {children}
      </body>
    </html>
  );
}
