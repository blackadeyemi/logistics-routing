# PostGIS plus pgvector for Phase 2 knowledge search.
FROM postgis/postgis:16-3.4
# The base image is Debian bullseye, whose PostgreSQL packages now live on
# the PGDG archive server.
RUN sed -i 's#http://apt.postgresql.org/pub/repos/apt#https://apt-archive.postgresql.org/pub/repos/apt#' /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-pgvector \
 && rm -rf /var/lib/apt/lists/*
