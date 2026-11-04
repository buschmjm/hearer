# syntax=docker/dockerfile:1

# One pinned base for both stages so the native better-sqlite3 build and the
# runtime share the same libc and Node ABI.
ARG NODE_IMAGE=node:24.22.2-alpine3.24

# ---------------------------------------------------------------------------
# Build stage: install, compile, and produce a production-only deploy tree.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build

# Toolchain for compiling better-sqlite3 if no prebuilt binary matches.
# hadolint ignore=DL3018
RUN apk add --no-cache python3 make g++

# Keep the pnpm version in sync with "packageManager" in the root package.json.
ENV PNPM_HOME=/pnpm \
    npm_config_store_dir=/pnpm/store \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.34.9 --activate

WORKDIR /repo
COPY . .

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Compile the server (esbuild bundle; better-sqlite3 stays external).
RUN pnpm --filter server build

# Web app (added in H-16). Skipped while apps/web does not exist; once it does
# this builds it with no Dockerfile change. The runtime stage copies /web-out.
RUN mkdir -p /web-out \
    && if [ -f apps/web/package.json ]; then \
         pnpm --filter web build && cp -r apps/web/dist/. /web-out/; \
       fi

# Production node_modules (includes the compiled better-sqlite3) next to the
# server's package.json. --legacy is required by pnpm 10 for workspace deploys.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter server deploy --prod --legacy /out

# Fail the build here, not at runtime, if the native module did not come along.
# Fall back to an explicit rebuild if the deploy skipped lifecycle scripts.
WORKDIR /out
RUN CHECK="new (require('better-sqlite3'))(':memory:').close(); require('argon2')" \
    && { node -e "$CHECK" \
         || { pnpm rebuild better-sqlite3 argon2 && node -e "$CHECK"; }; }

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="Hearer" \
      org.opencontainers.image.description="Self-hosted music request and upload portal." \
      org.opencontainers.image.source="https://github.com/buschmjm/hearer" \
      org.opencontainers.image.licenses="MIT"

# hadolint ignore=DL3018
RUN apk add --no-cache ffmpeg chromaprint tini su-exec tzdata

WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/server/dist ./dist
# Static web UI. Empty until apps/web exists (H-16); nothing to change then.
COPY --from=build /web-out ./public

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh \
    && mkdir -p /data /music /staging

ENV NODE_ENV=production \
    PORT=5055 \
    DATA_DIR=/data \
    MUSIC_DIR=/music \
    STAGING_DIR=/staging \
    PUID=1000 \
    PGID=1000 \
    UMASK=002

VOLUME ["/data", "/music", "/staging"]
EXPOSE 5055

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||5055)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
CMD ["node", "/app/dist/index.js"]
