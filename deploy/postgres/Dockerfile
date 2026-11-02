# PostgreSQL image for QA Tool, used by local development and by the cluster
# alike (D084).
#
# The official image does not ship pg_cron, which v0.1 uses for expired-session
# cleanup (D019, D041). Building it here means the extension, its
# shared_preload_libraries setting and its background-worker requirement are
# exercised by every test run instead of first meeting reality in production.
FROM postgres:16

RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-16-cron \
    && rm -rf /var/lib/apt/lists/*
