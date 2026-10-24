FROM node:24.22.1-bookworm-slim@sha256:1681862882da07ee5476fee047bcf34138833f1df42633bb25bcb0f438d5bf3d

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# The pnpm the workspace declares (`packageManager`), so images never drift from it.
RUN npm install --global "$(node -p 'require("./package.json").packageManager')" \
    && pnpm --version

COPY apps/transcription-agent/package.json apps/transcription-agent/tsconfig.json apps/transcription-agent/tsconfig.build.json ./apps/transcription-agent/
COPY packages/caption-protocol/package.json packages/caption-protocol/tsconfig.json ./packages/caption-protocol/
COPY packages/primitives/package.json packages/primitives/tsconfig.json ./packages/primitives/
RUN pnpm install --frozen-lockfile --filter @orbmeet/transcription-agent...

COPY packages/caption-protocol ./packages/caption-protocol
COPY packages/primitives ./packages/primitives
COPY apps/transcription-agent ./apps/transcription-agent
RUN pnpm --filter @orbmeet/transcription-agent build

# Runtime: invoke the built artifact directly instead of going through pnpm.
# The build already produced dist/main.js and installed node_modules, so
# `pnpm --filter ... start` (== `node dist/main.js start`) is unnecessary.
# Bare imports resolve via pnpm's symlinked node_modules walking up to /app.
WORKDIR /app/apps/transcription-agent
RUN mkdir -p /var/lib/orbmeet/transcription && chown node:node /var/lib/orbmeet/transcription
USER node
EXPOSE 8081
# node:sqlite (the journal) warns on every start, the job processes the agent
# forks included, and the warning reads as an error in the node's logs.
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning

CMD ["node", "dist/main.js", "start"]
