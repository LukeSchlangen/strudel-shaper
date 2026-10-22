# Multi-stage Dockerfile for Strudel Shaper on Cloud Run

# Stage 1: Build the frontend with Vite
FROM node:22-slim AS builder

WORKDIR /app

# Install dependencies (cached if package files don't change)
COPY package*.json ./
RUN npm ci

# Copy source code and build production assets into dist/
COPY . .
RUN npm run build

# Stage 2: Production runner
FROM node:22-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

# Install only runtime dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built frontend assets and required runtime files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/src ./src

# Cloud Run injects PORT (default 8080) and routes traffic to 0.0.0.0
ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080

CMD ["npm", "start"]
