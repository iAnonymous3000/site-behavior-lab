ARG PLAYWRIGHT_VERSION=1.61.0
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS build

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Public origin baked into the build so shared live-scan report links unfurl with
# their Open Graph / X card. Set this to the scanner's own public origin (e.g.
# https://scan.sitebehavior.org) at build time; NEXT_PUBLIC_ vars are inlined by
# `next build`, so a runtime env cannot change it. Empty default = no card image
# (links still render the report).
ARG NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL=""
ENV NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL=${NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL}

COPY package.json package-lock.json ./
RUN npm ci && npx playwright install chromium

COPY . .
RUN npm run check && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV SITE_BEHAVIOR_LAB_REPORT_STORE_DIR=/var/lib/site-behavior-lab/reports

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/lib/adblock-wasm ./lib/adblock-wasm
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.mjs ./next.config.mjs

RUN mkdir -p /var/lib/site-behavior-lab/reports
VOLUME ["/var/lib/site-behavior-lab/reports"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["./node_modules/.bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
