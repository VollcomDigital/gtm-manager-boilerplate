# GTM IaC (GTM API v2) — Project Plan

This repository aims to manage Google Tag Manager (GTM) containers **programmatically** using the **GTM API v2** in an **Infrastructure-as-Code (IaC)** style.

> Critical GTM API constraint: you **cannot** mutate a container directly — all changes must be made in a **Workspace**, then you create a **Container Version** and **Publish** it.

---

## Phase 1 — Foundation & Auth

- [ ] Initialize Node.js + TypeScript project (package.json, tsconfig, linting)
- [ ] Define environment conventions (.env / .env.example) for:
  - [ ] Service account key path (recommended for automation)
  - [ ] Target account/container selectors (IDs preferred over names)
- [ ] Implement GoogleAuth initialization (Service Account JSON key path via env)
- [ ] Build GTM API v2 client wrapper (initial skeleton)
- [ ] Add CLI/entrypoint to:
  - [ ] Authenticate
  - [ ] List accounts
  - [ ] List containers for a chosen account
- [ ] Add basic logging strategy (structured JSON logs recommended for CI)
- [ ] Document required IAM permissions + how to grant container access to the service account

---

## Phase 2 — Core CRUD Operations

### Workspace operations
- [ ] Get/create workspace by name (idempotent)
- [ ] Workspace cleanup strategy (delete/archival) for CI runs
- [ ] Validate GTM paths and IDs (accounts/*/containers/*/workspaces/*)

### Tags / Triggers / Variables (CRUD)
- [ ] Implement `get` by ID and `get` by name for:
  - [ ] Tags
  - [ ] Triggers
  - [ ] Variables
- [ ] Implement `create` (idempotent by name) for:
  - [ ] Tags
  - [ ] Triggers
  - [ ] Variables
- [ ] Implement `update` (patch) for:
  - [ ] Tags
  - [ ] Triggers
  - [ ] Variables
- [ ] Implement `delete` for:
  - [ ] Tags
  - [ ] Triggers
  - [ ] Variables
- [ ] Add pagination handling and retry/backoff for GTM API calls
- [ ] Add Zod validation for payloads before sending to the API

### Custom Templates (CRUD)
- [ ] Implement list/get/create/update/delete for:
  - [ ] Tag templates
  - [ ] Variable templates
- [ ] Template versioning strategy (pin content hashes)

### Versioning & publishing (required to apply workspace edits)
- [ ] Create container version from workspace
- [ ] Publish a container version
- [ ] Rollback strategy (re-publish previous version)

### Tests & safety checks
- [ ] Unit tests for:
  - [ ] Diff logic primitives (later reused in Phase 3)
  - [ ] Name-based resolution
  - [ ] Zod schema validations
- [ ] Add “dry-run” mode for all mutations

---

## Phase 3 — State Management (IaC)

### Desired-state schema
- [ ] Design a local desired-state format (JSON/YAML):
  - [ ] Container metadata + labels
  - [ ] Workspaces (logical grouping, or always single “iac” workspace)
  - [ ] Tags
  - [ ] Triggers
  - [ ] Variables
  - [ ] Custom templates
- [ ] Define schema with Zod and generate TypeScript types
- [ ] Create config loader:
  - [ ] Supports multiple environments (dev/stage/prod)
  - [ ] Supports per-container overlays (base + overrides)

### Diff engine
- [ ] Fetch current GTM workspace state (tags/triggers/variables/templates)
- [ ] Normalize API responses into a deterministic canonical form
- [ ] Compute a semantic diff:
  - [ ] Additions
  - [ ] Deletions
  - [ ] Updates (field-level)
- [ ] Diff output:
  - [ ] Human-readable (console)
  - [ ] Machine-readable (JSON artifact)

### Sync engine
- [ ] Apply changes to the workspace in a safe order:
  - [ ] Custom templates first (if needed by tags/variables)
  - [ ] Variables
  - [ ] Triggers
  - [ ] Tags (depends on triggers/variables)
- [ ] Handle referential integrity:
  - [ ] Trigger IDs referenced by tags
  - [ ] Variable references inside tag parameters
- [ ] Implement idempotent upserts by name + stable identifiers
- [ ] Add drift detection (current != desired) and fail CI when drift exists (optional policy)

---

## Phase 4 — CI/CD & Publishing

- [ ] Add GitHub Actions workflow for:
  - [ ] Install dependencies
  - [ ] Typecheck
  - [ ] Lint
  - [ ] Run unit tests
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

