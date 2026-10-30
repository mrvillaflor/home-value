FROM mcr.microsoft.com/playwright:v1.64.1-jammy

WORKDIR /app

COPY package.json package-lock.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev

COPY server.js scrape.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
