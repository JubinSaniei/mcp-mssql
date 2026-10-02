# Build stage
FROM node:22-slim AS build

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci

# Copy source files
COPY . .

# Build TypeScript code
RUN npm run build

# Production stage
FROM node:22-slim AS production

# Set working directory
WORKDIR /app

# Set environment variables
ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system app && adduser --system --ingroup app app

# Copy package files; the server reads its version from package.json
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy the compiled server
COPY --from=build /app/dist ./dist

# Switch to non-root user
USER app

# Add metadata about the image
LABEL maintainer="MSSQL MCP Team"
LABEL description="MCP SQL Server for Claude and other LLMs"

# Stdio MCP transport; the server logs to stderr only, since stdout carries the protocol
CMD ["node", "dist/server.js"]
