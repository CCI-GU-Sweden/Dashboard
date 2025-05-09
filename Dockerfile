# Use official Node.js image
FROM registry.access.redhat.com/ubi8/nodejs-18

# Create app directory inside container
WORKDIR /opt/app-root/src

# --- BACKEND SETUP ---

# Copy backend code
COPY backend/package*.json ./
RUN cd backend && npm install

# Copy backend source
COPY backend ./

# --- FRONTEND SETUP ---

# Copy static frontend to public folder
COPY frontend ./frontend

# --- SERVER ENTRY POINT ---

# Expose backend port
EXPOSE 8080

# Use a small static server for frontend
# We'll serve frontend via Express too (next step)
CMD ["node", "index.js"]
