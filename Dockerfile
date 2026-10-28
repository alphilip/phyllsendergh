FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3000

# Required: long random string used to sign login session cookies.
# Coolify -> Environment variables: SESSION_SECRET=<random 32+ chars>
# Data persists in the /data volume: /data/users.json plus one
# /data/<userId>/ directory per account (marketing.json, whatsapp-session, uploads).

EXPOSE 3000

CMD ["npm", "start"]
