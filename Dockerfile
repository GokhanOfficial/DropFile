FROM node:alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package manifests first for better layer caching
COPY package.json ./
COPY package-lock.json ./

# Install production dependencies
RUN npm install --production

# Copy the server configuration and the static public assets
COPY server.js ./
COPY public/ ./public/

# Expose the application port
EXPOSE 9392

# Start the Node.js static file server
CMD [ "node", "server.js" ]
