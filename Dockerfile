FROM oven/bun:1 AS base
WORKDIR /app

# ffmpeg powers the background Opus transcode (lib/media.ts). Without it the
# app still runs — transcoding just no-ops and /stream serves the master.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY . .

# apps/ (the Electron desktop app + Android sources) is excluded via
# .dockerignore, so `bun install` only resolves the web/ workspaces. This env
# var is belt-and-suspenders: if apps/ ever slips into the build context, it
# still stops the ~250MB Electron binary download in a server-only image.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN bun install

# Bundle the frontend (web/client/src/app.ts -> web/client/dist/app.js).
RUN bun run build

# dotenvx is a normal dependency (in package.json), so it installs into the
# project's world-readable node_modules. It is deliberately NOT `bun install
# -g`: a global install lands in root's home, which the non-root runtime user
# (compose `user: 1000:1002`) can't reach -> "Script not found dotenvx".

# The image's default HOME is root-owned; give the non-root runtime user a
# writable HOME so bun/bunx have somewhere for their cache.
ENV HOME=/tmp
ENV NODE_ENV=production
EXPOSE 4060

# dotenvx decrypts the mounted .env (using .env.keys), then we migrate
# (idempotent) and start the server. `bunx` resolves the local node_modules
# copy and runs it via bun (no Node needed in the image).
CMD ["sh", "-c", "bunx dotenvx run -- sh -c 'bun run migrate && bun run start'"]
