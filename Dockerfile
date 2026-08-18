# Stage 1: Build Next.js frontend
FROM node:22-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ .
ENV STATIC_EXPORT=1
ENV NEXT_PUBLIC_API_URL=""
RUN npm run build

# Stage 2: Python backend + serve frontend
FROM python:3.12-slim
WORKDIR /app

# Install Python dependencies
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend
COPY backend/ ./backend/

# Copy built frontend into backend's static dir
COPY --from=frontend-builder /app/frontend/out ./frontend_out/

# Copy the entrypoint
COPY render-entrypoint.sh .
RUN chmod +x render-entrypoint.sh

EXPOSE 8000

CMD ["./render-entrypoint.sh"]
