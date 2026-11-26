# Source Bridge - Docker image with g++ and a JDK, for Render (free Web Service).
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ gcc default-jdk-headless \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 user
USER user
ENV PATH="/home/user/.local/bin:$PATH" \
    PYTHONUNBUFFERED=1
WORKDIR /home/user/app

COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=user . .

# Render tells the app which port to use through $PORT (default 10000 if it is missing).
# 1 worker keeps the in-memory rate limiter consistent; 2 threads keep memory low on the free 512 MB plan.
CMD ["sh", "-c", "exec gunicorn --chdir backend main:app --bind 0.0.0.0:${PORT:-10000} --workers 1 --threads 2 --timeout 120"]