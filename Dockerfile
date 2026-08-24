# Official Playwright image - already has Chromium/Firefox/WebKit and their
# OS-level dependencies installed, so we don't have to install browsers ourselves.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

# Install dependencies first so this layer is cached when only source files change
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 5000

CMD ["node", "server.js"]
