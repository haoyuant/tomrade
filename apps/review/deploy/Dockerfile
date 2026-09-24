# The review worker. Build from the repository root:
#   docker build -f apps/review/deploy/Dockerfile -t tomrade-review .
# Run with no host mounts, a read-only root and outbound traffic limited to
# api.anthropic.com, github.com, codeload.github.com, registry.npmjs.org and
# the Supabase project — it builds code strangers wrote.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter "@tomrade/review..." && pnpm exec tsc -b apps/review
USER node
ENV NODE_ENV=production
CMD ["node", "apps/review/dist/cli.js", "worker"]
