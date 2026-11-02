# Multi-stage Dockerfile for MediMate RAG Microservice
# Stage 1: Build virtual environment
FROM python:3.12-slim AS builder

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN python -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip && \
    /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

# Stage 2: Hardened Runtime Container
FROM python:3.12-slim AS runner

WORKDIR /app

# Non-root user configuration (UID 10001)
RUN groupadd -g 10001 raggroup && \
    useradd -u 10001 -g raggroup -s /bin/bash -m raguser

# Copy virtual environment
COPY --from=builder --chown=raguser:raggroup /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONPATH="/app"
ENV PYTHONUNBUFFERED=1

# Scratch workspace with non-root ownership
RUN mkdir -p /tmp/rag-scratch && chown -R raguser:raggroup /tmp/rag-scratch

# Copy service source code
COPY --chown=raguser:raggroup app /app/app

USER raguser:raggroup

EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health/live')" || exit 1

ENTRYPOINT ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
