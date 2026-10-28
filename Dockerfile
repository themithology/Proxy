FROM node:22-alpine

LABEL org.opencontainers.image.title="LOL Embed player" \
      org.opencontainers.image.description="LOL Embed player, API, stream proxy and MKV-to-HLS converter"

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

ENV NODE_ENV=production \
    PLAYER_PORT=3000 \
    HOST=0.0.0.0 \
    MKV_HLS_ENABLED=true \
    MKV_HLS_NODE_HOST=true \
    MKV_HLS_DIR=/data/hls

RUN mkdir -p /data/hls && chown -R node:node /data/hls

USER node

EXPOSE 3000

CMD ["node", "scripts/player-server.mjs"]
