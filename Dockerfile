ARG PLAYWRIGHT_VERSION=1.61.0
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS build

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Public origin baked into the build so shared live-scan report links unfurl with
# their Open Graph / X card. NEXT_PUBLIC_ vars are inlined by `next build`, so a
# runtime env cannot change it — and Cloudflare Workers Builds builds this image
# without passing a --build-arg, so the default below is what ships. Defaults to
# this deployment's scanner origin; override with --build-arg for a self-host, or
# set "" to omit the card image (links still render the report).
ARG NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL="https://scan.sitebehavior.org"
ENV NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL=${NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL}

# Public Turnstile site key, inlined into the client bundle the container also
# serves. The scanner enforces Turnstile, so without this the scan form on the
# container origin — including on shared /reports/:id pages — shows a "no site
# key" error and cannot scan. As with SITE_URL, NEXT_PUBLIC_ vars are inlined at
# build time and Workers Builds passes no --build-arg, so this default is what
# ships. Turnstile *site* keys are public (rendered to every visitor); only the
# secret key is server-side. Self-hosts on another domain override with their own.
ARG NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY="0x4AAAAAADo4etedrrGyi43a"
ENV NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY=${NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY}

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
