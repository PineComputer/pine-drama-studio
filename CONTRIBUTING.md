# Contributing to Pine Drama Studio

Thank you for helping.

Questions and discussion: [Discord](https://discord.gg/jBRrXmQHT).

## Before you start

- Open an issue first for anything larger than a small fix, so the approach can be agreed before you write it.
- Read [AGENTS.md](AGENTS.md): the working rules apply to people and coding agents alike.
- The contract between the Studio and a Pine Computer is the [protocol](doc/protocol.md); the terms are in the
  [vocabulary](doc/vocabulary.md).

## How to change the code

1. **Reuse the workbench.** Native views, editors, Chat and the Command Palette come from Code-OSS. Build a lookalike
   only when the native part does not work, and say why in the pull request.
2. **Use the lowest layer.** Prefer the extension (`extensions/pine-drama/`), then a new file under a `pine/` folder in
   Code-OSS, and edit an existing Code-OSS file only when nothing else can. Changes to Code-OSS are the patch series in
   `upstream/patches/`, exported with `scripts/upstream-export.sh` and checked with `scripts/upstream-check.sh`.
3. **Add a test** for new behaviour, and a failing-first test for a bug fix. Tests never touch the network or spend
   money.
4. **Write in English**: code, comments, docs, commit messages and pull requests.

## Pull requests

- One change per pull request. Pull requests are squash-merged into `main`.
- State what you ran and what it printed.

## Developer Certificate of Origin

Every commit must be signed off, certifying the [Developer Certificate of Origin](https://developercertificate.org/):

```
git commit -s
```

This adds a `Signed-off-by: Your Name <you@example.com>` line, stating that you wrote the change or have the right to
submit it under the project's license (Apache-2.0).
