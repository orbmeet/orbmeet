# One Node for both stages: the dependencies are installed by the runtime that runs them.
FROM node:24.22.1-alpine@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d AS dependencies

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# The pnpm the workspace declares (`packageManager`), so images never drift from it.
RUN npm install --global "$(node -p 'require("./package.json").packageManager')" \
    && pnpm --version

COPY apps/whiteboard-server/package.json ./apps/whiteboard-server/package.json
COPY packages/whiteboard-core/package.json ./packages/whiteboard-core/package.json
COPY packages/primitives/package.json ./packages/primitives/package.json
RUN pnpm install --prod --frozen-lockfile --filter @orbmeet/whiteboard-server...

COPY apps/whiteboard-server ./apps/whiteboard-server
COPY packages/whiteboard-core ./packages/whiteboard-core
COPY packages/primitives ./packages/primitives

FROM node:24.22.1-alpine@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d

RUN apk add --no-cache \
    fontconfig \
    mupdf-tools \
    font-dejavu \
    font-liberation \
    font-freefont \
    font-noto \
    font-noto-bengali \
    font-noto-cjk \
    font-noto-extra \
    font-noto-math \
    && fc-cache -f

RUN addgroup -S -g 10001 appgroup && adduser -S -u 10001 -G appgroup appuser

WORKDIR /app
COPY --from=dependencies /app /app
RUN mkdir -p /data/rooms && chown -R appuser:appgroup /data/rooms /app

USER appuser
WORKDIR /app/apps/whiteboard-server
EXPOSE 8787
# health check so Docker/compose can detect when the server is ready
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8787/health || exit 1
# Node runs the TypeScript sources as they are, stripping their types.
CMD ["node", "src/index.ts"]
