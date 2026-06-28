# ── base ──────────────────────────────────────────────────────────────────────
FROM python:3.11-slim AS base
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── dev ───────────────────────────────────────────────────────────────────────
FROM base AS dev
ENV PYTHONPATH=/app/src
# source mounted as volume by compose; --reload watches for changes
CMD ["uvicorn", "registry.main:app", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--reload", "--reload-dir", "/app/src"]

# ── prod ──────────────────────────────────────────────────────────────────────
FROM base AS prod
COPY src/ ./src/
ENV PYTHONPATH=/app/src
RUN adduser --disabled-password --gecos "" appuser \
 && chown -R appuser /app
USER appuser
CMD ["uvicorn", "registry.main:app", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "2"]
