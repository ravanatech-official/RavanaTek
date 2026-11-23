# ---- Stage 1: Build allowlisted public output + install production dependencies ----
FROM node:24-slim AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY scripts/build-public.mjs ./scripts/build-public.mjs
COPY index.html projects.html services.html privacy.html terms.html security.html data-policy.html 404.html ./
COPY googled6cb87aabbea33cf.html robots.txt sitemap.xml security.txt styles.css main.js ravana.webp ./
COPY favicon.ico favicon.png favicon.svg apple-touch-icon.png manifest.webmanifest ./
COPY work1.jpg work2.jpg work3.jpg work4.jpg work5.jpg work6.jpg ./
COPY .well-known ./.well-known
COPY api ./api
COPY assets ./assets
COPY src/assets/images/ravana_tech_logo_1792581937150.jpg ./src/assets/images/ravana_tech_logo_1792581937150.jpg
COPY src/assets/images/ravana_tech_logo_opt.webp ./src/assets/images/ravana_tech_logo_opt.webp
COPY ["conceptual projects", "./conceptual projects"]

RUN node scripts/build-public.mjs

# ---- Stage 2: Minimal non-root Cloud Run runtime ----
FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV STORAGE_BACKEND=cloud

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/public-build ./public-build
COPY server.js ./server.js

RUN chown -R node:node /app
USER node

EXPOSE 8080

CMD ["node", "server.js"]
