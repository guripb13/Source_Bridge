# =============================================================================
# Dockerfile — Source Bridge web application (Gemini API + Flask frontend)
# =============================================================================
# This container serves the web UI and calls the Gemini API.
# It does NOT run user-submitted code directly when RUNNER_URL is set.
# User code execution is delegated to the runner container (Dockerfile.runner).
#
# Build:
#   docker build -t source-bridge-web .
#
# Run standalone (development only — no runner isolation):
#   docker run -p 8000:8000 \
#     -e GEMINI_API_KEY="your-real-key" \
#     source-bridge-web
#
# Run in production (use docker-compose.yml instead — it wires up both
# containers with the correct network isolation):
#   docker compose up --build
# =============================================================================

FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 -s /bin/false runner

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt gunicorn>=22.0.0

# Explicitly listed — Demo testing/ and any .env or .db files are excluded.
# .dockerignore provides a belt-and-braces backstop.
COPY backend/main.py           ./backend/main.py
COPY backend/compiler.py       ./backend/compiler.py
COPY backend/convertibility.py ./backend/convertibility.py
COPY frontend/                 ./frontend/

RUN chown -R runner:runner /app
USER runner

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/me || exit 1

CMD ["gunicorn", \
     "--bind", "0.0.0.0:8000", \
     "--workers", "2", \
     "--timeout", "90", \
     "--log-level", "info", \
     "--access-logfile", "-", \
     "backend.main:app"]
