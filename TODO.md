# GTM IaC (GTM API v2) — Project Plan

This repository aims to manage Google Tag Manager (GTM) containers **programmatically** using the **GTM API v2** in an **Infrastructure-as-Code (IaC)** style.

> Critical GTM API constraint: you **cannot** mutate a container directly — all changes must be made in a **Workspace**, then you create a **Container Version** and **Publish** it.

---

## Phase 1 — Foundation & Auth

- [x] Initialize Node.js + TypeScript project (package.json, tsconfig, linting)
- [x] Define environment conventions (.env / .env.example) for:
  - [x] Service account key path (recommended for automation)
  - [x] Target account/container selectors (IDs preferred over names)
- [x] Implement GoogleAuth initialization (Service Account JSON key path via env)
- [x] Build GTM API v2 client wrapper (initial skeleton)
- [x] Add CLI/entrypoint to:
  - [x] Authenticate
  - [x] List accounts
  - [x] List containers for a chosen account
- [x] Add basic logging strategy (structured JSON logs recommended for CI)
- [x] Document required IAM permissions + how to grant container access to the service account

---

## Phase 2 — Core CRUD Operations

### Workspace operations
- [x] Get/create workspace by name (idempotent)
- [x] Workspace cleanup strategy (delete/archival) for CI runs
- [x] Validate GTM paths and IDs (accounts/*/containers/*/workspaces/*)

### Tags / Triggers / Variables (CRUD)
- [x] Implement `get` by ID and `get` by name for:
  - [x] Tags
  - [x] Triggers
  - [x] Variables
- [x] Implement `create` (idempotent by name) for:
  - [x] Tags
  - [x] Triggers
  - [x] Variables
- [x] Implement `update` (API update/PUT) for:
  - [x] Tags
  - [x] Triggers
  - [x] Variables
- [x] Implement `delete` for:
  - [x] Tags
  - [x] Triggers
  - [x] Variables
- [x] Add pagination handling and retry/backoff for GTM API calls
- [x] Add Zod validation for payloads before sending to the API

### Custom Templates (CRUD)
- [x] Implement list/get/create/update/delete for:
  - [x] Tag templates
  - [x] Variable templates
- [ ] Template versioning strategy (pin content hashes)

### Versioning & publishing (required to apply workspace edits)
- [x] Create container version from workspace
- [x] Publish a container version
- [ ] Rollback strategy (re-publish previous version)

### Tests & safety checks
- [ ] Unit tests for:
  - [ ] Diff logic primitives (later reused in Phase 3)
  - [x] Name-based resolution
  - [x] Zod schema validations
- [x] Add “dry-run” mode for all mutations

---

## Phase 3 — State Management (IaC)

### Desired-state schema
- [x] Design a local desired-state format (JSON/YAML):
  - [ ] Container metadata + labels
  - [ ] Workspaces (logical grouping, or always single “iac” workspace)
  - [x] Tags
  - [x] Triggers
  - [x] Variables
  - [x] Custom templates
- [x] Define schema with Zod and generate TypeScript types
- [ ] Create config loader:
  - [ ] Supports multiple environments (dev/stage/prod)
  - [ ] Supports per-container overlays (base + overrides)

### Diff engine
- [x] Fetch current GTM workspace state (tags/triggers/variables/templates)
- [x] Normalize API responses into a deterministic canonical form
- [x] Compute a semantic diff:
  - [x] Additions
  - [x] Deletions
  - [x] Updates (field-level)
- [ ] Diff output:
  - [x] Human-readable (console)
  - [x] Machine-readable (JSON artifact)

### Sync engine
- [x] Apply changes to the workspace in a safe order:
  - [x] Custom templates first (if needed by tags/variables)
  - [x] Variables
  - [x] Triggers
  - [x] Tags (depends on triggers/variables)
- [ ] Handle referential integrity:
  - [x] Trigger IDs referenced by tags
  - [ ] Variable references inside tag parameters
- [x] Implement idempotent upserts by name + stable identifiers
- [ ] Add drift detection (current != desired) and fail CI when drift exists (optional policy)

---

## Phase 4 — CI/CD & Publishing

- [x] Add GitHub Actions workflow for:
  - [x] Install dependencies
  - [x] Typecheck
  - [x] Lint
  - [x] Run unit tests
- [ ] Add workflow to run “diff” on PRs and upload diff artifacts
- [ ] Add workflow to run “sync” on main merges (protected environments)
- [ ] Automate version creation + publishing:
  - [ ] Create container version from workspace
  - [ ] Publish version
  - [ ] Emit summary with version ID and timestamp
- [ ] Secrets management:
  - [ ] Service account key via GitHub OIDC (preferred) or encrypted secret
  - [ ] Avoid storing JSON keys in repo
- [ ] Release process:
  - [ ] Version the IaC tool (semantic releases)
  - [ ] Generate changelogs

