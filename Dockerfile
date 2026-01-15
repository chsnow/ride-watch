FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy application code
COPY index.js ./

# Set environment
ENV NODE_ENV=production

# Expose the port Cloud Run will use
EXPOSE 8080

# Start the application
CMD ["node", "index.js"]
