FROM node:20.9-alpine

# Instalace curl pro health check
RUN apk add --no-cache curl

# Nastavení pracovního adresáře
WORKDIR /usr/src/app

# Kopírování package.json (bez package-lock.json)
COPY package.json ./

# Instalace závislostí s npm install (vytvoří nový package-lock.json)
RUN npm install --omit=dev && npm cache clean --force

# Kopírování zdrojových kódů
COPY . .

# Exponování portu
EXPOSE 7000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:7000/manifest.json || exit 1

# Spuštění aplikace
CMD ["node", "sktorrent-addon.js"]
