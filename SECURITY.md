# Security Policy

## Supported Versions

We only apply security fixes to the most recent commit on the default branch. Tagged releases or downstream forks should cherry-pick relevant patches.

## Reporting a Vulnerability

1. Email security@vollcomdigital.com or open a private advisory on GitHub.
2. Provide a detailed description, reproduction steps, and potential impact.
3. We will acknowledge receipt within 2 business days and aim to deliver a fix or mitigation within 14 days.

Please avoid publicly disclosing vulnerabilities before we have had a chance to address them.

## Security Features

This repository enables GitHub native security protections:
- Dependabot alerts and version updates for Python dependencies (`poetry.lock`, `pyproject.toml`).
- Secret scanning alerts, including custom patterns for GTM keys.
- Code scanning using GitHub Advanced Security with the CodeQL workflow (Python configured).

If you discover a false positive or want to suggest additional rules, reach out through the reporting channel above.
