FROM python:3.14-slim AS base

ENV POETRY_VERSION=1.8.3 \
    POETRY_VIRTUALENVS_CREATE=false \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN pip install "poetry==${POETRY_VERSION}"

WORKDIR /app

COPY pyproject.toml poetry.lock /app/

RUN poetry install --no-interaction --no-ansi --no-root

COPY . /app

CMD ["poetry", "run", "python", "src/exporters/export_ga4_from_gtm.py", "--help"]
