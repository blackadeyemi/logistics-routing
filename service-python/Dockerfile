FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Bake the embedding model into the image so search works offline and the
# first request is not a 130 MB download. /app is a dev volume, so the
# model lives outside it.
ENV FASTEMBED_CACHE_PATH=/models
RUN python -c "from fastembed import TextEmbedding; TextEmbedding('BAAI/bge-small-en-v1.5')"

COPY . .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
