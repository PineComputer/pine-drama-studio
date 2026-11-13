# Script fixtures

`rewrite/` is a drama-cli project with one screenplay version, made by drama-cli itself, not written by hand:

- `screenplay.md` (the original, not Fountain), `rewrite.fountain` (a Fountain rewrite of it) and `brief.md` (a brief
  with the producer's part and the screenplay author's part) were written for this fixture.
- `drama-cli init` and `drama-cli screenplay validate rewrite.fountain` (both free, no provider
  call) wrote `drama-cli.cfg.yaml` and `screenplay/` (`current.json`, `candidate.json`, `v1/`).
- Only one thing was changed afterwards: the scratch directory the project was made in is replaced by
  `/var/lib/sandbox/sessions/fixture` in every file, so its paths read as a Computer's. The manifest's SHA-256 of
  `validate.json` and `review.md` is therefore not theirs any more; nothing in the Studio checks it.

The rewrite unifies three ways the original names one speaker (`Dr. Quinn`, `Mara`, `Quinn` become `MARA`), removes a
sentence, adds a line, and keeps the author's character list in a `[[…]]` note, so `removed`, `added`, `not_produced` and
the line map `lines[].to` (D172) all have entries.
