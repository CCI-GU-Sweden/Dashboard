# Use official Node.js image
FROM registry.access.redhat.com/ubi8/nodejs-18

WORKDIR /opt/app-root/src

# The UBI Node image builds as UID 1001, so copied manifests must be writable
# by that user. The root group keeps the image compatible with OpenShift's
# arbitrary runtime UID model.
COPY --chown=1001:0 backend/package*.json ./

# Use the committed lockfile for a deterministic production install.
RUN npm ci --omit=dev

# Copy backend source code to root
COPY --chown=1001:0 backend/ ./

# Copy frontend to a subfolder
COPY --chown=1001:0 frontend ./frontend

EXPOSE 8080

CMD ["node", "index.js"]
