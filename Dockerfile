# NFS-e Belém - microserviço de assinatura + emissão
FROM node:20-alpine

# fuso horário de Belém (para dhEmi/dCompet corretos)
ENV TZ=America/Belem
RUN apk add --no-cache tzdata

WORKDIR /app

# instala dependências primeiro (melhor cache)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# código da aplicação
COPY server.js dps-builder.js company.config.json ./

EXPOSE 3005

# healthcheck: EasyPanel/Docker reinicia se o processo travar
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3005/health || exit 1

CMD ["node", "server.js"]
