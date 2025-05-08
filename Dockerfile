# Use official Node.js image
FROM node:18-alpine

# Create app directory inside container
WORKDIR /app

# --- BACKEND SETUP ---

# Copy backend code
COPY backend/package*.json ./backend/
RUN cd backend && npm install

# Copy backend source
COPY backend ./backend

# --- FRONTEND SETUP ---

# Copy static frontend to public folder
COPY frontend ./frontend

# --- SERVER ENTRY POINT ---

# Expose backend port
EXPOSE 3000

# Use a small static server for frontend
# We'll serve frontend via Express too (next step)
CMD ["node", "backend/index.js"]
