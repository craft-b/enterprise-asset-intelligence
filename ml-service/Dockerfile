FROM python:3.12-slim

WORKDIR /app/ml-service

# System deps needed by some ML packages (scipy, numba, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc \
        g++ \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies (pinned for reproducibility)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy ML service source
COPY . .

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONIOENCODING=utf-8

EXPOSE 8000

# Fetches the champion artifacts when the registry is empty (no persistent
# disk), then execs uvicorn. See the script for MODEL_BUNDLE_URL.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
