# Ekatra API + worker + admin console — reproducible build.
# Pinned to Node 24.16.0 (see package.json engines + .nvmrc).
# Build stage compiles backend/UI; runtime stage runs non-root with production deps only.

FROM node:24.16.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY admin-ui/package.json admin-ui/package-lock.json ./admin-ui/
RUN npm ci --prefix admin-ui
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY admin-ui ./admin-ui
RUN npm run build

FROM node:24.16.0-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    MEDIA_DIR=/app/media
# DATABASE_URL comes from the environment (compose file or host secrets), never baked in.
WORKDIR /app

# Non-root user (Debian slim already ships `node` uid 1000; create dedicated appuser).
RUN useradd --create-home --uid 1001 --user-group appuser \
  && mkdir -p /app/media \
  && chown -R appuser:appuser /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=appuser:appuser /app/dist ./dist
COPY --from=build --chown=appuser:appuser /app/admin-ui/dist ./admin-ui/dist
# Ship sample attachments so the container works without a media volume pre-seed.
COPY --chown=appuser:appuser media ./media

USER appuser
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Default is the API. The worker and one-shot migration job use this image with separate commands
# (see docker-compose.yml).
# The API never sends WhatsApp messages; the worker owns delivery + schedule.
CMD ["node", "dist/server.js"]
