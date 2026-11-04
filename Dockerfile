# Saka Fleet backend — Cloud Run image (v1.58.8)
# Build: gcloud run deploy saka-fleet --source .  (Cloud Build uses this Dockerfile)
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
# Layer cache: install production deps first
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# App source. NOTE: SAKA_FLEET_ARCHITECTURE.md is read at boot for the release
# version (deployLiveAlert.readReleaseVersion), so it must be in the image.
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "index.js"]
