# GTM Manager Boilerplate

Public boilerplate for managing Google Tag Manager (GTM) containers and tags across projects.

## What's inside

- GA4 exporter (`src/exporters/export_ga4_from_gtm.py`) that pulls the latest container version and writes GA4 tags plus parameters to CSV.
- Target-key-aware configuration so multiple container IDs can be managed from a single YAML mapping.
- Poetry, Docker Compose, and pre-commit hooks to keep development consistent across operating systems.

## Getting started

```bash
poetry install
```

### Running the exporter

Direct container IDs:

```bash
poetry run python src/exporters/export_ga4_from_gtm.py \
  --auth user \
  --account-id 2824463661 \
  --container-id 51955729 \
  --credentials /absolute/path/to/client_secrets.json \
  --output ./data/exports/ga4_tags.csv
```

Using a target-key mapping:

```bash
poetry run python src/exporters/export_ga4_from_gtm.py \
  --auth user \
  --target-key site_a \
  --credentials /absolute/path/to/client_secrets.json \
  --output ./data/exports/ga4_tags.csv
```

You can also skip the file entirely and supply mappings via an environment variable. Example (PowerShell):

```powershell
$env:GTM_TARGETS_JSON = '{"site_a":{"account_id":"0000000000","container_id":"GTM-ABC123"}}'
poetry run python src/exporters/export_ga4_from_gtm.py `
  --auth user `
  --target-key site_a `
  --credentials $env:GTM_CREDENTIALS_PATH `
  --output ./data/exports/ga4_tags.csv
```

Grouped entries (e.g., `central: { ga4: {...} }`) are flattened automatically to keys such as `central_ga4`.

### Listing GTM accounts

```bash
poetry run python src/exporters/list_gtm_accounts.py \
  --auth user \
  --credentials /absolute/path/to/client_secrets.json \
  --with-containers
```

Use `--output ./accounts.json` to persist the response or drop `--with-containers` to only list account metadata. A convenience wrapper is available via `scripts/list_accounts.sh`.

## Authentication options

- **User OAuth flow (default and recommended)**: Create OAuth client credentials in Google Cloud Console (Desktop App) and store the JSON securely outside the repo. Point `--credentials` (or `GTM_CREDENTIALS_PATH`) at that file; a browser consent screen opens on first run and caches tokens locally.
- **Service account** *(optional, if your org provides one)*: Store the service-account key JSON outside the repo and reference it via `--credentials` or `GTM_CREDENTIALS_PATH`. Ensure the service account has at least read access to the GTM containers.

## Docker usage

### User OAuth example

Mount your desktop OAuth client secrets into the container and run:

```bash
docker compose run --rm \
  -e GTM_TARGET_KEY=site_a \
  -e GTM_AUTH_METHOD=user \
  -e GTM_CREDENTIALS_PATH=/secrets/client_secrets.json \
  -v /absolute/path/to/client_secrets.json:/secrets/client_secrets.json:ro \
  gtm-manager
```

### Service account example

Build once, then run with either direct IDs or a target key. Example with target-key mapping:

```bash
docker compose run --rm \
  -e GTM_TARGET_KEY=site_a \
  -e GTM_AUTH_METHOD=service \
  -e GTM_CREDENTIALS_PATH=/secrets/service_account.json \
  -v /absolute/path/to/service_account.json:/secrets/service_account.json:ro \
  gtm-manager
```

For direct IDs, omit `GTM_TARGET_KEY` and set `GTM_ACCOUNT_ID` and `GTM_CONTAINER_ID` instead. Optional overrides:

- `GTM_TARGETS_JSON` for supplying multiple mappings directly in the container environment (single-line JSON).
- Legacy aliases are still accepted: `GTM_SALESLINE`, `GTM_SALESLINES_JSON`, and CLI flag `--salesline`.
- `GTM_OUTPUT_PATH` (defaults to `/app/data/exports/ga4_tags.csv`)

## Pre-commit hooks

Install hooks after `poetry install`:

```bash
poetry run pre-commit install
poetry run pre-commit run --all-files
```

The hook set covers linting and formatting via Ruff (including import sorting and Bugbear rules), typing checks with mypy, and general hygiene checks.

## Configuration

- Duplicate `.env.example` to `.env` (or export the variables in your shell) and fill in paths, account IDs, and JSON mappings as needed.
- Store OAuth client secrets or service-account keys outside the repository and point `GTM_CREDENTIALS_PATH` (or `--credentials`) to their absolute location.
- Provide GTM account/container mappings via the `GTM_TARGETS_JSON` environment variable. The JSON payload should look like `{"site_a":{"account_id":"...","container_id":"..."}}`. Grouped entries such as `central.ga4` can be represented by nested objects, which the exporter flattens automatically.
- Exported CSV files live in `data/exports/`, which remains outside version control.

## Project layout

```text
.
|-- .dockerignore
|-- .editorconfig
|-- .gitignore
|-- .pre-commit-config.yaml
|-- .env.example
|-- CONTRIBUTING.md
|-- .github/
|   |-- dependabot.yml
|   |-- workflows/
|   |   |-- codeql.yml
|   |   |-- dependency-review.yml
|   |   |-- gitleaks.yml
|   |   |-- semgrep.yml
|   |   |-- secret-scanning.yml
|   |   └── sonarcloud.yml
|-- Dockerfile
|-- docker-compose.yml
|-- pyproject.toml
|-- README.md
|-- data/
|   `-- exports/
|-- scripts/
|   |-- export_ga4_tags.sh
|   |-- list_accounts.sh
|   `-- sync_all_containers.sh
`-- src/
    |-- __init__.py
    |-- exporters/
    |   |-- export_ga4_from_gtm.py
    |   `-- list_gtm_accounts.py
    |-- managers/
    |   |-- container_manager.py
    |   |-- tag_manager.py
    |   `-- trigger_manager.py
    `-- utils/
        |-- auth.py
        `-- helpers.py
```

## TypeScript (Node.js) — GTM IaC scaffold (WIP)

This repository also contains a **Node.js + TypeScript** scaffold for managing GTM via **GTM API v2** in an IaC style.

### Install / build

```bash
npm install
npm run typecheck
npm run build
```

### Authentication (service account)

1. In Google Cloud Console, create a **service account** and download a JSON key file.
1. Enable the **Google Tag Manager API** for the project.
1. In the GTM UI, add the **service account email** as a user on the relevant GTM Account/Container with at least:
   - **Edit** permissions for workspace mutations
   - **Publish** permissions if you want to publish container versions
1. Configure env vars (see `.env.example`):
   - `GTM_CREDENTIALS_PATH=/absolute/path/to/service_account.json`

> Note: OAuth user flows are not wired up in the TypeScript scaffold yet; the current focus is CI-friendly service account auth.

### CLI examples

```bash
# List GTM accounts accessible by the credential
npm run cli -- list-accounts --json

# List containers in an account
npm run cli -- list-containers --account-id 1234567890 --json

# Ensure a workspace exists (required for GTM API v2 mutations)
npm run cli -- ensure-workspace --account-id 1234567890 --container-id 51955729 --workspace-name Automation-Test --json

# Create a container version from the workspace
npm run cli -- create-version --account-id 1234567890 --container-id 51955729 --workspace-name Automation-Test --version-name "IaC Release" --notes "Automated publish" --json

# Inspect live (currently published) version
npm run cli -- live-version --account-id 1234567890 --container-id 51955729 --json
```

Optional:

- Override scopes via `GTM_SCOPES` (comma/space-separated). This is useful for workspace deletion workflows, which typically require `https://www.googleapis.com/auth/tagmanager.delete.containers`.

Rollback strategy:

- Store previously published `containerVersion.path` values (the CI workflows upload them as artifacts when enabled).
- To rollback, publish the prior version path:
  - `npm run cli -- publish-version --version-path accounts/<acct>/containers/<cid>/versions/<vid> --json`

### IaC snapshot / diff / sync (Phase 3 scaffolding)

```bash
# Export a workspace snapshot (tags/triggers/variables/templates) in a stable JSON shape
npm run cli -- export-workspace --account-id 123 --container-id 456 --workspace-name "Automation-Test" --out ./workspace.snapshot.json

# Diff a workspace against a desired-state JSON file
npm run cli -- diff-workspace --account-id 123 --container-id 456 --workspace-name "Automation-Test" --config ./desired.workspace.json --json

# Fail non-zero if drift exists (useful for CI)
npm run cli -- diff-workspace --account-id 123 --container-id 456 --workspace-name "Automation-Test" --config ./desired.workspace.json --fail-on-drift

# Apply desired state (safe order: templates → variables → triggers → tags)
npm run cli -- sync-workspace --account-id 123 --container-id 456 --workspace-name "Automation-Test" --config ./desired.workspace.json --dry-run --json
```

Notes:

- `sync-workspace` supports resolving tag trigger references by **name** using `firingTriggerNames` / `blockingTriggerNames` in the desired tag object. These are IaC-only fields and are not part of the GTM API schema.
- `sync-workspace` and `diff-workspace` include **Zones** (GTM 360 feature) when present via GTM API v2 workspaces/zones.
- Config files can be **JSON or YAML** (`.json`, `.yml`, `.yaml`).
- You can pass **overlays** by providing a comma-separated list to `--config`, e.g. `--config ./base.yml,./prod.yml` (later files override earlier ones by entity name).
- Custom templates can optionally be pinned with `__sha256` (SHA-256 of `templateData`). Use `npm run cli -- hash-config --config <file> --json` to compute hashes.

### Multi-container repo config (Phase 3)

For managing multiple GTM containers from a single repo config:

```yaml
# gtm.repo.yml
schemaVersion: 1
defaults:
  workspaceName: iac

containers:
  - key: site_a
    labels:
      env: prod
      region: eu
    target:
      accountId: "1234567890"
      containerId: "51955729"   # numeric containerId (preferred)
      # OR: containerPublicId: "GTM-XXXXXXX"
    workspace:
      workspaceName: iac
      triggers:
        - name: All Pages
          type: PAGEVIEW
      tags:
        - name: "GA4 - Configuration"
          type: gaawc
          firingTriggerNames: ["All Pages"] # IaC-only convenience field
          parameter:
            - key: measurementId
              type: TEMPLATE
              value: "G-XXXXXXXXXX"
```

Commands:

```bash
# Diff all selected containers
npm run cli -- diff-repo --config ./gtm.repo.yml --labels env=prod --fail-on-drift --json

# Sync all selected containers (dry-run)
npm run cli -- sync-repo --config ./gtm.repo.yml --container-keys site_a,site_b --dry-run --json
```

### GitHub Actions: optional GTM diff on PRs

This repo ships a `gtm-diff` workflow that is **skipped by default** unless you configure secrets/vars:

- Secrets:
  - `GTM_SERVICE_ACCOUNT_JSON_B64` (base64-encoded service-account JSON; fallback option)
  - OR (preferred) `GCP_WORKLOAD_IDENTITY_PROVIDER` + `GCP_SERVICE_ACCOUNT_EMAIL` for GitHub OIDC
  - `GTM_ACCOUNT_ID`
  - `GTM_CONTAINER_ID`
- Vars:
  - `GTM_WORKSPACE_NAME` (default: `Automation-Test`)
  - `GTM_DESIRED_CONFIG_PATH` (default: `desired.workspace.json`)

When configured, PRs will run `diff-workspace --fail-on-drift` and upload `gtm.diff.json` as an artifact.

### GitHub Actions: optional GTM sync + publish

This repo also ships a `gtm-sync` workflow:

- `workflow_dispatch` supports:
  - running `sync-workspace` (optionally `--delete-missing`)
  - optionally creating + publishing a container version
- `push` to `main` is supported but **opt-in** via repo variable `GTM_SYNC_ON_PUSH=true`.

Required secrets:

- `GTM_SERVICE_ACCOUNT_JSON_B64`
- `GTM_ACCOUNT_ID`
- `GTM_CONTAINER_ID`

OIDC alternative (preferred):

- Secrets:
  - `GCP_WORKLOAD_IDENTITY_PROVIDER`
  - `GCP_SERVICE_ACCOUNT_EMAIL`
- If these are set, the workflows will authenticate to GCP without storing a JSON key.

Required vars for push-based sync:

- `GTM_WORKSPACE_NAME`
- `GTM_DESIRED_CONFIG_PATH`

### Releases (optional)

There is a manual `release` workflow (`workflow_dispatch`) powered by **semantic-release**. It tags releases and updates `CHANGELOG.md` based on Conventional Commits.

### Security automation

- Dependabot monitors Python (`pip`), Node (`npm`), Docker, and GitHub Actions dependencies.
- CodeQL scans both Python and JavaScript/TypeScript code.
- `dependency-review` runs on pull requests to block newly introduced high-severity vulnerable dependencies.
- `gitleaks` runs on pull requests and pushes to detect committed secrets.
- `semgrep` runs security-focused static analysis rules on pull requests and pushes.
- `sonarcloud` runs on pull requests and pushes to `main` when these repository settings are present:
  - Secret: `SONAR_TOKEN`
  - Variables: `SONAR_ORGANIZATION`, `SONAR_PROJECT_KEY`

### Example automation script

`src/index.ts` demonstrates:

- authenticating
- resolving a container
- creating a workspace `Automation-Test`
- creating an "All Pages" trigger
- adding a basic GA4 Configuration tag into that workspace
