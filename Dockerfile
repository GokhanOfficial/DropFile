FROM node:alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy the server configuration and the static public assets
COPY server.js ./
COPY public/ ./public/

# Expose the application port
EXPOSE 9392

# Start the Node.js static file server
CMD [ "node", "server.js" ]
