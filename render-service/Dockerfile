# Blue Ocean render service - headless-browser lane on Render
# Exposes POST /render {url, token} -> {html, status, engine, challenged}
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    RENDER_HEADED=0

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb xauth \
        # Chromium deps
        libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
        libdrm2 libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 \
        libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 \
        # Firefox/Camoufox deps
        libgtk-3-0 libx11-xcb1 libxtst6 libxcomposite1 libxdamage1 \
        fonts-liberation && \
    rm -rf /var/lib/apt/lists/*

RUN pip install "flask==3.0.3" "gunicorn==23.0.0" \
        "playwright==1.49.1" "playwright-stealth==2.0.0" "camoufox[geoip]" && \
    python -m playwright install chromium && \
    python -m camoufox fetch

COPY render_worker.py .

EXPOSE 10000
CMD ["gunicorn", "-w", "1", "--threads", "4", "-t", "180", "-b", "0.0.0.0:10000", "render_worker:app"]
