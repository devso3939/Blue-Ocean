#!/bin/bash
set -e

# Set data directory
export BLUEOCEAN_DATA_DIR=${BLUEOCEAN_DATA_DIR:-/data}
mkdir -p "$BLUEOCEAN_DATA_DIR"

# Copy frontend static files to a serveable location
cp -r /app/frontend_out /app/static_frontend 2>/dev/null || true

echo "Starting Blue Ocean API server..."
echo "Data directory: $BLUEOCEAN_DATA_DIR"
echo "Port: ${PORT:-8000}"

# Start the FastAPI server
cd /app/backend
exec python -m uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}
