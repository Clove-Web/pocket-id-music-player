FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install

COPY . .

# Bundle the frontend (web/app.ts -> dist/app.js).
RUN bun run build

RUN bun install -g @dotenvx/dotenvx

ENV NODE_ENV=production
EXPOSE 4060

# dotenvx decrypts the mounted .env (using .env.keys), then we migrate
# (idempotent) and start the server.
CMD ["dotenvx", "run", "--", "sh", "-c", "bun run migrate && bun run start"]
