# Routine Maintenance Audit — 2026-02-23

Repository: **gtm-manager-boilerplate**
Tech stack: TypeScript/Node.js + Python (Poetry), Docker, GitHub Actions

______________________________________________________________________

### Dependency Management with Dependabot

**Status: Pass (after fix)**

- [x] `.github/dependabot.yml` exists with schedule definitions.
- [x] `pip` ecosystem configured (weekly, with ignore rule for major `google-api-python-client` bumps).
- [x] `github-actions` ecosystem configured (weekly).
- [x] `npm` ecosystem added — was previously missing despite a significant TypeScript/Node.js codebase.
- [x] `docker` ecosystem added — was missing despite `Dockerfile` and `docker-compose.yml`.
- [ ] Consider adding a `composer` or other ecosystem entry if additional package managers are introduced.

### Vulnerability Alerts with GitHub Security

**Status: Pass (after fix)**

- [x] `SECURITY.md` exists with supported-versions, reporting instructions, and security-feature summary.
- [x] CodeQL workflow (`.github/workflows/codeql.yml`) exists and runs on push, PR, and weekly schedule.
- [x] CodeQL now scans **both** `python` and `javascript-typescript` — was previously Python-only.
- [x] Secret-scanning workflow (`.github/workflows/secret-scanning.yml`) enables GitHub Advanced Security.
- [ ] Consider enabling Dependabot security alerts at the repository Settings level if not already active.

### Security Risk Monitoring with SonarQube Cloud

**Status: Pass (after fix)**

- [x] `sonar-project.properties` exists with correct source/test/exclusion paths.
- [x] `.sonarcloud.properties` exists (mirrors `sonar-project.properties`).
- [x] SonarCloud scan step added to `node-ci.yml` — was previously missing from all CI pipelines despite config files being present.
- [ ] Ensure the `SONAR_TOKEN` repository secret is configured in GitHub Settings for the scan to execute.

### AI-Powered Threat Detection with Cursor AI

**Status: Pass**

- [x] No hardcoded secrets, API keys, passwords, or tokens found in source code.
- [x] No unsafe `eval()`, `exec()`, or `Function()` constructor calls detected.
- [x] No SQL/NoSQL injection vectors (repository does not perform database operations).
- [x] No XSS vectors (CLI/backend tool with no HTML rendering).
- [x] No hardcoded URLs containing embedded credentials.
- [x] No insecure random-number generation in security contexts.
- [x] File-path traversal properly mitigated with null-byte checks, newline guards, and workspace-root boundary validation in `src/iac/load-repo-config.ts`, `src/iac/load-config.ts`, and `src/cli.ts`.
- [x] All GitHub Actions workflows use `${{ secrets.* }}` for credentials — no inline secrets.
- [ ] Low: `enableDebug: true` exists in test fixture `src/test/fixtures/workspace-desired.json` — acceptable for test data, but verify it is never copied into production configs.

### Compliance and Best Practices Review

**Status: Pass (after fix)**

- [x] `README.md` exists and is comprehensive.
- [x] `LICENSE` exists (MIT).
- [x] `.gitignore` exists and covers Python, Node, editor, and OS artifacts.
- [x] `.editorconfig` added — was previously missing.
- [x] `CONTRIBUTING.md` added — was previously missing.
- [x] `CHANGELOG.md` exists (managed by semantic-release).
- [x] `.env.example` exists with clear comments and no real credentials.
- [x] ESLint configured for TypeScript (`eslint.config.mjs`).
- [x] Ruff + mypy configured for Python (`pyproject.toml`, `.pre-commit-config.yaml`).
- [x] Pre-commit hook versions updated to latest releases: `pre-commit-hooks` v4.6.0 → v6.0.0, `ruff-pre-commit` v0.6.8 → v0.15.2, `mirrors-mypy` v1.11.2 → v1.19.1.
- [x] `Dockerfile` now copies `poetry.lock` alongside `pyproject.toml` for reproducible builds.
- [x] `docker-compose.yml` deprecated `version` key removed (Docker Compose V2+ ignores it).
- [ ] `README.md` "Project layout" section is outdated — missing TypeScript source tree (`src/iac/`, `src/lib/`, `src/config/`, `src/types/`, `src/test/`), and missing workflow files (`node-ci.yml`, `release.yml`, `gtm-sync.yml`, `gtm-diff.yml`).
- [ ] `mdformat` pre-commit hook still at v0.7.21 — v1.0.0 is available on PyPI but may require `mdformat-gfm` compatibility verification before upgrading.
