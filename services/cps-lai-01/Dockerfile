FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY config ./config

RUN mkdir -p /app/aas

ENV NODE_ENV=production
ENV PORT=3010
ENV MQTT_URL=mqtt://acsm-mosquitto:1883
ENV MQTT_BASE_TOPIC=cpslai1
ENV FIELD_MAPPING_FILE=/app/config/field-mapping.example.json
ENV AAS_FILE=/app/aas/aas.json

EXPOSE 3010

CMD ["node", "src/server.js"]
