import type { Metadata, Viewport } from "next";
import { Poppins, Geist_Mono } from "next/font/google";
import { Providers } from "@/components/common/Providers";
import { networkFromCookies } from "@/lib/network-server";
import "./globals.css";

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-poppins",
  display: "swap",
});
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  // `|| fallback` (not ??): an EMPTY NEXT_PUBLIC_APP_URL is defined but makes
  // new URL("") throw ERR_INVALID_URL and kill the whole build.
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"),
  title: "Kryon | Perpetuals DEX",
  description: "Decentralised perpetual futures on Stellar/Soroban — BTC, ETH, XLM, SOL, XRP, ADA, BNB and TRX perpetuals",
  applicationName: "Kryon",
  icons: {
    icon: [
      { url: "/favicon.png", type: "image/png" },
      { url: "/favicon.ico", sizes: "48x48" },
    ],
    apple: { url: "/apple-icon.png", sizes: "180x180", type: "image/png" },
  },
  openGraph: {
    title: "Kryon | Perpetuals DEX",
    description: "Decentralised perpetual futures on Stellar/Soroban",
    siteName: "Kryon",
    images: [{ url: "/icon-512.png", width: 512, height: 512 }],
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#19191A",
  width: "device-width",
  initialScale: 1,
  // Allow pinch-zoom for accessibility; iOS input auto-zoom is prevented via a
  // 16px min font-size on inputs in globals.css instead of locking the scale.
  maximumScale: 5,
  // Extend the canvas under the iOS notch / home indicator; pair with safe-area
  // padding utilities (.pt-safe / .pb-safe) so content stays clear of insets.
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the cookie opts this layout into request-time rendering, which is
  // required and intended: the chrome differs per selected network.
  const network = await networkFromCookies();

  return (
    <html lang="en" className={`${poppins.variable} ${geistMono.variable} dark h-full`}>
      <body className="min-h-dvh bg-[#19191A] text-[#f5f5f5] antialiased">
        <Providers network={network}>{children}</Providers>
      </body>
    </html>
  );
}
