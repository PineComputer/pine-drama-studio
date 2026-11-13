# Pine Drama Studio

A desktop studio for AI short dramas, built on Code-OSS. You write or bring a screenplay; an agent on a
[Pine Computer](https://pinecomputer.io) makes the drama with you: characters, locations and props, keyframes,
storyboards, takes and the cut. You review and choose in the Studio; the drama's folder on your machine is its only copy.

[![Discord](https://img.shields.io/badge/Discord-community-5865F2?logo=discord&logoColor=white)](https://discord.gg/jBRrXmQHT)

**Community:** questions, ideas and help on [Discord](https://discord.gg/jBRrXmQHT).

- **Left:** the project, its assets and episodes. **Center:** the canvas, the galleries and the editors. **Right:** the
  Chat with the agent and its reviews. **Bottom:** diagnostics.
- The Studio and a Pine Computer speak one open, add-only [protocol](doc/protocol.md). The terms are defined, with their
  film-industry sources, in the [vocabulary](doc/vocabulary.md).

A project's custom presets, the prompt templates the agent's tools write and draw with, go in its `inputs/preset/`
folder: see [presets](doc/presets.md).

## Conventions

- Docs are Markdown in [GitHub Flavored Markdown](https://github.github.com/gfm/).
- The [protocol](doc/protocol.md) uses the key words of [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119), and its schema is [JSON Schema 2020-12](https://json-schema.org/draft/2020-12).
- Screenplays are [Fountain](https://fountain.io/syntax).
- Releases are numbered by [Semantic Versioning](https://semver.org/).
- Commits are signed off under the [Developer Certificate of Origin](https://developercertificate.org/).
- Production terms follow the film and VFX industry's sources, named for each term in the [vocabulary](doc/vocabulary.md).

## Install

Signed macOS builds (Apple silicon) will be published on this repository's Releases page. Until then, build from
source (below).

## Quickstart

1. Get a Pine project key (`pk_…`) at [pinecomputer.io](https://pinecomputer.io).
2. Open Pine Drama Studio and connect with the key (Accounts menu › Pine Computer). The key is kept in your operating
   system's secret storage.
3. Create a project (File › New Project…), choose an empty folder, and drop in your screenplay.
4. Talk to the agent in the Chat. Each paid step starts only after you say go, and you approve the results on the
   canvas.

## Build from source

Requirements: macOS, git, Node.js (the version in Code-OSS's `.nvmrc`) and the Code-OSS build prerequisites
(https://github.com/microsoft/vscode/wiki/How-to-Contribute).

```
git clone https://github.com/PineComputer/pine-drama-studio.git
cd pine-drama-studio
scripts/upstream-setup.sh          # clones Code-OSS beside this folder at the pinned commit and applies upstream/patches
cd ../vscode && npm ci && npm run compile && cd -
cd extensions/pine-drama && npm ci && npm run compile && cd -
scripts/dev-launch.sh               # starts the Studio on the compiled Code-OSS
```

`scripts/package-macos.sh` packages a `.app`. The extension's tests: `cd extensions/pine-drama && npm test`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (commits are signed off under the DCO) and the working rules in
[AGENTS.md](AGENTS.md). Report security issues privately: [SECURITY.md](SECURITY.md).

## License

Apache-2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)). Code-OSS is MIT-licensed by Microsoft.
