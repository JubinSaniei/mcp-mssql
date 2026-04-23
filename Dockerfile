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

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy necessary files from build stage
COPY --from=build /app/dist ./dist
COPY --from=build /app/config.js ./
COPY --from=build /app/types.d.ts ./
COPY --from=build /app/claude-mcp-config.json ./

# Copy scripts
COPY --from=build /app/docker-run.sh ./

# Make scripts executable
RUN chmod +x *.sh

# Create entrypoint (no stdout logging — would corrupt MCP stdio transport)
RUN echo 'import "./dist/server.js";' > entrypoint.mjs

# Switch to non-root user
USER app

# Add metadata about the image
LABEL maintainer="MSSQL MCP Team"
LABEL description="MCP SQL Server for Claude and other LLMs"
LABEL version="1.0.1"

# Set the default command - using stdio transport for MCP
CMD ["node", "--enable-source-maps", "entrypoint.mjs"]
