import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";
import { themes as prismThemes } from "prism-react-renderer";

const config: Config = {
  title: "Kryon Protocol",
  tagline: "Decentralised perpetual futures on Stellar / Soroban",
  favicon: "img/favicon.png",

  // Served from the same deployment as the trading client, under /docs.
  url: "https://client-eight-mu-71.vercel.app",
  baseUrl: "/docs/",
  // Emit non-trailing-slash routes so they line up with Next's default
  // trailing-slash handling + the /docs rewrites in client/next.config.ts.
  trailingSlash: false,
  organizationName: "kryon",
  projectName: "kryon-protocol",

  onBrokenLinks: "warn",

  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: "warn",
    },
  },

  themes: ["@docusaurus/theme-mermaid"],

  i18n: { defaultLocale: "en", locales: ["en"] },

  presets: [
    [
      "classic",
      {
        docs: {
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: { defaultMode: "dark", respectPrefersColorScheme: true },
    navbar: {
      title: "KRYON",
      // Clicking the logo / KRYON wordmark returns to the landing page (site
      // root), not the docs home. `href` is emitted as-is, so it escapes the
      // /docs/ baseUrl prefix. target _self keeps it in the same tab.
      logo: { alt: "Kryon", src: "img/logo.png", width: 44, height: 44, href: "/", target: "_self" },
      items: [
        { type: "docSidebar", sidebarId: "docs", position: "left", label: "Documentation" },
        { href: "https://github.com/SamyaDeb/KryonV2", label: "GitHub", position: "right" },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Protocol",
          items: [
            { label: "Architecture", to: "/architecture/protocol" },
            { label: "Soroban Contracts", to: "/architecture/contracts" },
            { label: "Trading Lifecycle", to: "/trading/lifecycle" },
          ],
        },
        {
          title: "Build",
          items: [
            { label: "Local Development", to: "/operations/local-dev" },
            { label: "REST API", to: "/api/rest" },
            { label: "WebSocket Events", to: "/api/websocket" },
          ],
        },
        {
          title: "Operate",
          items: [
            { label: "Deployment", to: "/operations/deployment" },
            { label: "Security", to: "/security" },
            { label: "Mainnet Readiness", to: "/mainnet-readiness" },
          ],
        },
      ],
      copyright: `Kryon Protocol — built on Stellar / Soroban.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["rust", "toml", "bash", "sql"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
