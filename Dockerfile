FROM node:22-alpine

LABEL org.opencontainers.image.title="LOL Embed backend" \
      org.opencontainers.image.description="Backend API and stream workers; no browser frontend is bundled"

# Node deployments can inspect and remux embedded audio streams into HLS
# renditions. The Cloudflare Worker build intentionally does not use binaries.
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

CMD ["node", "src/server.js"]
