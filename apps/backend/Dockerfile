# Backend image. Build from the repository root:
#   docker build -f apps/backend/Dockerfile -t qa-tools-backend .
#
# The backend has no build step: Node 24 runs the TypeScript sources directly
# (D051). That decision constrains this image. Node refuses to strip types from
# files under node_modules, and the code only stays outside that restriction
# because npm workspaces link node_modules/@webhook-inspector/shared to packages/shared.
# So the workspace layout is reproduced here — root manifest, packages/shared,
# apps/backend — and npm creates the symlink exactly as it does locally.
FROM node:24-slim

ENV NODE_ENV=production

WORKDIR /app

# Manifests before sources, so the dependency layer survives a code change.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/

RUN npm ci --omit=dev --workspace @webhook-inspector/backend --include-workspace-root

COPY packages/shared/src packages/shared/src
# The API description, whose info.version /mcp reports as the server's (D203).
COPY packages/shared/openapi.json packages/shared/openapi.json
COPY apps/backend/src apps/backend/src
# Migrations ship with the image so the same artifact that serves traffic can
# apply the schema it expects.
COPY apps/backend/migrations apps/backend/migrations

USER node
WORKDIR /app/apps/backend

# The container must accept connections from outside itself; the default of
# 127.0.0.1 exists to keep local development off the surrounding network.
ENV BACKEND_HOST=0.0.0.0
ENV BACKEND_PORT=3000
# The application listener, and the receive listener for webhooks (D187),
# whose port RECEIVE_PORT sets and defaults to 3001.
EXPOSE 3000 3001

CMD ["node", "src/index.ts"]
