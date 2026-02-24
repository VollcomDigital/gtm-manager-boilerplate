# Contributing

Thank you for considering a contribution to this project. The following guidelines help keep the process smooth and consistent.

## Getting started

1. Fork the repository and create a feature branch from `main`.
2. Install dependencies for both stacks:
   ```bash
   npm install
   poetry install
   ```
3. Enable pre-commit hooks:
   ```bash
   poetry run pre-commit install
   ```

## Code style

- **TypeScript**: ESLint enforces style rules (`npm run lint`). Run `npm run typecheck` before pushing.
- **Python**: Ruff handles linting and formatting. mypy checks types. Pre-commit hooks run both automatically.
- Follow [Conventional Commits](https://www.conventionalcommits.org/) for all commit messages (`feat:`, `fix:`, `perf:`, `chore:`, etc.).

## Pull requests

1. Keep PRs focused on a single concern.
2. Ensure all CI checks pass (typecheck, lint, test).
3. Add or update tests when changing behavior.
4. Update `README.md` if your change affects public usage or configuration.

## Reporting issues

Use GitHub Issues. Include reproduction steps, expected behavior, and any relevant logs or configuration.

## Security vulnerabilities

Please report security issues privately via the GitHub Security tab. See `SECURITY.md` for details.
