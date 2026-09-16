FROM node:22-alpine
RUN apk add --no-cache bash
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

# tsx runs every keeper script directly from TypeScript; pm2 supervises the
# fleet as one container-friendly foreground process (pm2-runtime, not the
# daemonised pm2). Both installed at BUILD time, not fetched via npx at
# runtime — a Railway container has no guarantee runtime npm registry access
# behaves like build-time access, and testnet-keepers crash-looped silently
# for exactly this reason before this Dockerfile existed.
RUN npm install tsx pm2 --save-dev

CMD ["bash", "scripts/railway-testnet-entrypoint.sh"]
