# Security policy

## Supported versions

Hearer is pre-alpha and has no stable releases. Only the latest commit on `main` is supported. Once v1.0 ships, this table will list the supported release lines.

| Version | Supported |
| ------- | --------- |
| `main`  | Yes       |
| others  | No        |

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Use GitHub's private vulnerability reporting: go to the repository's **Security** tab, choose **Report a vulnerability**, and describe the issue, affected version or commit, and steps to reproduce.

You can expect an acknowledgement within a few days and a status update as the report is triaged. Once a fix is available, we will coordinate disclosure with you and credit you if you wish.

## Scope

Of particular interest: authentication and session handling, permission checks, path traversal or writes outside the library root, upload handling, secret storage, and SSRF through configurable URLs.
