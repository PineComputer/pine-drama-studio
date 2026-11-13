# Security policy

## Reporting a vulnerability

Please do not report security vulnerabilities in public issues. Use GitHub's private vulnerability reporting ("Report a
vulnerability" under this repository's **Security** tab), or write to security@19pine.ai. Include what you found, how to
reproduce it, and what it affects. We will acknowledge your report and keep you informed while we fix it.

## Scope

This repository: the Pine Drama Studio app, its built-in extension and the Code-OSS patches in `upstream/patches/`.
Vulnerabilities in Code-OSS itself belong upstream (https://github.com/microsoft/vscode/security). Pine Computer is a
separate product; report issues in it through the same private channel.

## Secrets

The Studio stores the Pine project key in the operating system's secret storage and shows a key only by its public
prefix. Never put a key, a `.env` file or a Pine session credential in an issue, a pull request or a log you share.
