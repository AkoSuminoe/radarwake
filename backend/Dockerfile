# Build context: repo koku (docker-compose.yml'de context: .)

# --- 1) Dashboard (Next.js static export) ---
FROM node:22-alpine AS dashboard
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# --- 2) Backend ---
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY backend/requirements.txt .
RUN pip install -r requirements.txt

RUN useradd --system --uid 10001 --home /app radarwake \
    && mkdir -p /app/data && chown radarwake /app/data
COPY backend/app ./app
COPY --from=dashboard /src/out ./static

USER radarwake
VOLUME ["/app/data"]
EXPOSE 8000 8001

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2)"

CMD ["python", "-m", "app.main"]
