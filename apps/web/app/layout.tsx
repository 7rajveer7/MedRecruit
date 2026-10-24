import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MedRecruit | Local physician ATS",
  description: "Local-first ATS for physician roles, resume evidence, shortlists, and recruiter-led screening."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
