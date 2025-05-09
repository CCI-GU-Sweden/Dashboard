# Use official Node.js image
FROM registry.access.redhat.com/ubi8/nodejs-18

WORKDIR /opt/app-root/src

# Copy backend/package.json and package-lock.json to the root
COPY backend/package*.json ./

# Install dependencies in the root (no cd needed)
RUN npm install

# Copy backend source code to root
COPY backend/ ./

# Copy frontend to a subfolder
COPY frontend ./frontend

EXPOSE 8080

CMD ["node", "index.js"]
