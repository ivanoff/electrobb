FROM oven/bun:1.3.0

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash util-linux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --chmod=755 run.sh ./run.sh
COPY src ./src

USER bun
ENTRYPOINT ["./run.sh"]
