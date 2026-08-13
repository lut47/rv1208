FROM oven/bun:1.3.14 AS base

WORKDIR /app

FROM base AS install

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS runtime

ENV NODE_ENV=production

COPY --from=install /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src

CMD ["bun", "run", "src/main.ts"]
