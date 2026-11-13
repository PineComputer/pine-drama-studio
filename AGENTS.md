# Working rules

These rules are for people and coding agents who change this repository. `CLAUDE.md` imports this file.

- **One worktree per task.** Never switch branches in your main checkout; make a `git worktree` for each task.
- **No test runs on the maintainer's Mac.** Run the suites through `scripts/test-on-pine-dev.sh studio <ref>`, which
  runs them on the shared test host; locally, only edit, use git and type-check (`npx tsc -p .`). Contributors without
  access to the host run `npm test` on their own machine.
- **Pull requests, squash-merged.** `main` is protected; `scripts/setup-hooks.sh` installs hooks that refuse commits and
  pushes on `main`. One change per pull request; say what you ran and what it printed.
- **Independent review for shared state.** A change to shared state (task or session records, locks, the install of a
  return, choices) gets a review by Codex, or by a reviewer who did not write it, before or right after merge.
- **Delete dead code.** Remove code, exports, config and docs that nothing uses any more; replacing code deletes the old
  path in the same change. No backward compatibility while the product is in development.
- **English only**, in code, comments, docs, commits and pull requests. A comment says why; it cites a public source, not
  an internal document.
- **Nothing fabricated.** Every status, cost and approval on screen comes from a named source (the protocol's files or
  Pine). No paid call starts without the person's explicit action.
