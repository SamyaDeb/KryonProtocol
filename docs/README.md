# Kryon Protocol Documentation

Production documentation for the Kryon perpetuals DEX, built with
[Docusaurus](https://docusaurus.io/).

## Develop

```bash
cd docs
npm install
npm start          # http://localhost:3000 (docs dev server)
```

## Build

```bash
npm run build      # static site → ./build
npm run serve      # preview the production build
```

## Structure

```
docs/
├── docusaurus.config.ts   # site config (nav, footer, theme)
├── sidebars.ts            # sidebar structure
├── src/css/custom.css     # Kryon brand theme
├── static/img/            # logo + favicon
└── docs/                  # documentation content
    ├── intro.md
    ├── architecture/      # protocol, contracts, frontend, backend, infra
    ├── trading/           # lifecycle, execution-engine, order-lifecycle, pnl-funding
    ├── data/              # database, leaderboard, portfolio
    ├── api/               # rest, websocket
    ├── operations/        # local-dev, env-setup, onboarding, deployment
    ├── security.md
    ├── scaling.md
    └── mainnet-readiness.md
```

Content is grounded in the live codebase (`client/`, `kryon-protocol/`) — keep
it in sync when contracts, APIs, or services change.
