# Contributing Guide

Thanks for contributing to this repository.

## Development setup

1. Bootstrap Node + Python dependencies in one command:

   ```bash
   bash scripts/bootstrap_ci.sh
   ```

   This runs `npm ci` and `poetry install --with dev`, and reuses lockfile-hash stamps under `.cache/bootstrap/` to skip unchanged reinstalls.

2. Install pre-commit hooks:

   ```bash
   poetry run pre-commit install
   ```

## Local quality checks

Run these before opening a pull request:

```bash
npm run typecheck
npm run lint
npm test
poetry run pre-commit run --all-files
```

## Commit conventions

Use semantic commit prefixes to keep history clear:

- `feat:` for new features
- `fix:` for bug fixes
- `perf:` for performance improvements
- `chore:` for maintenance and tooling updates
- `docs:` for documentation changes

## Security requirements

- Never commit credentials, API keys, tokens, or private keys.
- Keep OAuth/service account files outside the repository and reference them via environment variables.
- Report vulnerabilities through the process documented in `SECURITY.md`.

## Pull request checklist

- Include a clear problem statement and scope.
- Add or update tests when behavior changes.
- Ensure CI passes (linting, tests, and security workflows).
- Update documentation for user-facing changes.
