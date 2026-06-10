FROM python:3.11-alpine

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

RUN adduser -D -h /app appuser

COPY app.py .
COPY web/ ./web/

RUN chown -R appuser:appuser /app

EXPOSE 8080

ENV PORT=8080
ENV DB_PATH=/app/statistics.sqlite3

USER appuser

CMD ["python", "app.py"]
