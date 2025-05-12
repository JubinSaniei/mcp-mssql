# Build stage
FROM node:23-slim AS build

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
FROM node:23-slim AS production

# Set working directory
WORKDIR /app

# Set environment variables
ENV NODE_ENV=production

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy necessary files from build stage
COPY --from=build /app/dist ./dist
COPY --from=build /app/config.js ./
COPY --from=build /app/types.d.ts ./
COPY --from=build /app/claude-mcp-config.json ./

# Copy test scripts 
COPY --from=build /app/docker-run.sh ./

# Make scripts executable
RUN chmod +x *.sh

# Create a simple entrypoint script for ESM handling
RUN echo '#!/usr/bin/env node\n\
// ESM entrypoint for MCP SQL Server with session persistence\n\
console.log("Starting MCP SQL Server with session persistence...");\n\
import "./dist/server.js";\n' > entrypoint.mjs && \
chmod +x entrypoint.mjs

# Add metadata about the image
LABEL maintainer="MSSQL MCP Team"
LABEL description="MCP SQL Server with session persistence for Claude and other LLMs"
LABEL version="1.0.0"

# Set the default command - using stdio transport for MCP
CMD ["node", "--enable-source-maps", "entrypoint.mjs"]