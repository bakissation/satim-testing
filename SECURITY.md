# Security Policy

## Supported versions

This project follows semantic versioning. Security fixes are applied to the **latest released minor version** only. Please upgrade before reporting.

## Reporting a vulnerability

**Do not open a public issue or pull request for security vulnerabilities.**

Report privately via GitHub's **Private Vulnerability Reporting**:

1. Go to the [Security tab](https://github.com/bakissation/satim-testing/security) of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, affected version, and reproduction steps.

You'll get an acknowledgement and can track the fix in the private advisory.

## Why this matters here

`@bakissation/satim-testing` is a **test-only mock** of the SATIM gateway — a `devDependency`. It performs **no network, filesystem, or credential I/O** and **must never be used in production code paths**. It deliberately fabricates approvals/declines, so the only security-relevant concern is misuse:

- **Never** wire the mock into a production build — it would "approve" payments that never happened.
- The mock invents test data only; it carries **no real card numbers or credentials** (test PANs come from SATIM's published certification cards).

If you find a way the mock could be mistaken for, or substituted into, a real gateway path, that's in scope.

## Out of scope

- Issues requiring an already-compromised machine.
- Advisories in **dev-only** dependencies (build/test/release toolchain) not reachable at runtime.
- The fact that the mock approves payments — that is its purpose; do not ship it to production.
