import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    "intro",
    {
      type: "category",
      label: "Architecture",
      collapsed: false,
      items: [
        "architecture/overview",
        "architecture/protocol",
        "architecture/contracts",
        "architecture/frontend",
        "architecture/backend",
        "architecture/infra",
      ],
    },
    {
      type: "category",
      label: "Trading",
      items: [
        "trading/lifecycle",
        "trading/execution-engine",
        "trading/order-lifecycle",
        "trading/pnl-funding",
      ],
    },
    {
      type: "category",
      label: "Data & Analytics",
      items: ["data/database", "data/leaderboard", "data/portfolio"],
    },
    {
      type: "category",
      label: "Build an Agent",
      collapsed: false,
      items: [
        "agents/quickstart",
        "agents/signing",
        "agents/units",
        "agents/lifecycle",
        "agents/risk",
        "agents/funding",
        "agents/mainnet",
      ],
    },
    {
      type: "category",
      label: "APIs",
      items: ["api/rest", "api/websocket"],
    },
    {
      type: "category",
      label: "Operations",
      items: [
        "operations/local-dev",
        "operations/env-setup",
        "operations/onboarding",
        "operations/deployment",
      ],
    },
    "security",
    "scaling",
    "mainnet-readiness",
  ],
};

export default sidebars;
