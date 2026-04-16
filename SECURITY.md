# Security Policy

## Supported Versions

Only the latest release is supported with security updates.

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.**

Use [GitHub's private vulnerability reporting](https://github.com/SoftwareStartups/gdrivescope/security/advisories/new) to submit a report. You will receive an acknowledgement within 72 hours and a detailed response within one week.

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Scope

**In scope:** gdrivescope CLI — authentication, credential storage, local file operations, data handling, dependency vulnerabilities.

**Out of scope:** Google Drive API, Google OAuth infrastructure, third-party LLM provider APIs.

## Credential Handling

gdrivescope stores credentials exclusively in the OS keychain via Bun's Secrets API. No credentials are written to disk files. API keys are read from environment variables at runtime and never persisted by the tool.
