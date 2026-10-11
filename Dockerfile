# Multi-stage build for the standalone Next.js server.
#
# Stage 1 resolves dependencies once so later builds reuse the npm layer
# unless package.json / package-lock.json change.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Stage 2 compiles the app with the full source tree on top of the cached
# dependencies. Sentry telemetry is disabled and no SENTRY_AUTH_TOKEN is
# present, so source-map upload is skipped instead of failing the build.
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 \
    SENTRY_TELEMETRY=false
RUN npm run build

# Stage 3 ships only what the standalone trace produced: the server entry,
# its traced node_modules, runtime artifacts and the static/public assets.
# Appwrite credentials, the passkey, session secret, cron secret and
# encryption keys are all supplied at runtime via environment variables.
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
# The standalone server is invoked with `node server.js`; the npm tooling
# bundled into the base image is dead weight and its audit surface (pacote,
# brace-expansion, sigstore, ...) has no reason to ship, so strip it.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]