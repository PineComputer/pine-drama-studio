# Pine Drama Studio

A desktop studio for AI short dramas, built on Code-OSS. You write or bring a screenplay; an agent on a
[Pine Computer](https://pinecomputer.io) makes the drama with you: characters, locations and props, keyframes,
storyboards, takes and the cut. You review and choose in the Studio; the drama's folder on your machine is its only copy.

[![Pine Drama Studio launch film: click to watch (4K, 51 s)](https://cdn.19pine.ai/pine-drama-studio/pine-drama-studio-launch-cover.jpg)](https://cdn.19pine.ai/pine-drama-studio/pine-drama-studio-launch-4k.mp4)

![Every episode on its own canvas: storyboards, keyframes, takes.](https://cdn.19pine.ai/pine-drama-studio/readme-episode.jpg)

![Characters, locations and props, drawn once and reused in every shot.](https://cdn.19pine.ai/pine-drama-studio/readme-assets.jpg)

[![Discord](https://img.shields.io/badge/Discord-community-5865F2?logo=discord&logoColor=white)](https://discord.gg/jBRrXmQHT)

**Community:** questions, ideas and help on [Discord](https://discord.gg/jBRrXmQHT).

- **Left:** the project, its assets and episodes. **Center:** the canvas, the galleries and the editors. **Right:** the
  Chat with the agent and its reviews. **Bottom:** diagnostics.
- The Studio and a Pine Computer speak one open, add-only [protocol](doc/protocol.md). The terms are defined, with their
  film-industry sources, in the [vocabulary](doc/vocabulary.md).

## Presets

You don't need to provide a preset: Pine Computers come with built-in presets, and the agent picks one or uses the one
you name. To use your own, write it as [presets](doc/presets.md) describes (the format, the reply schemas and a minimal
sample) and put it in your project's `inputs/preset/<your-preset>/`.

## Conventions

- Docs are Markdown in [GitHub Flavored Markdown](https://github.github.com/gfm/).
- The [protocol](doc/protocol.md) uses the key words of [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119), and its schema is [JSON Schema 2020-12](https://json-schema.org/draft/2020-12).
- Screenplays are [Fountain](https://fountain.io/syntax).
- Releases are numbered by [Semantic Versioning](https://semver.org/).
- Commits are signed off under the [Developer Certificate of Origin](https://developercertificate.org/).
- Production terms follow the film and VFX industry's sources, named for each term in the [vocabulary](doc/vocabulary.md).

## Install

1. Download the latest release from the [Releases page](https://github.com/PineComputer/pine-drama-studio/releases/latest):
   the `.dmg` for your Mac, `darwin-arm64` for Apple silicon or `darwin-x64` for Intel. Both are signed and notarized by
   Apple.
2. Open it and drag Pine Drama Studio to Applications. From then on the app updates itself.
3. Get a Pine project key (`pk_…`) at [pinecomputer.io](https://pinecomputer.io).

To build it yourself instead, see [Build from source](#build-from-source).

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

`scripts/package-macos.sh` packages a `.app` for Apple silicon (`--arch=x64` for Intel Macs). The Windows x64 installer is built, signed and tested in CI (`.github/workflows/release-win32.yml`, with `scripts/package-win32.mjs` and `scripts/release-win32.mjs`). The extension's tests: `cd extensions/pine-drama && npm test`.

A package you build yourself is ad-hoc signed. If it runs first, it creates the "Pine Drama Studio Safe Storage" keychain item, and macOS may then ask for your login keychain password when the signed release uses it. Choose Always Allow: later releases that meet the same designated requirement keep that access without asking again.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (commits are signed off under the DCO) and the working rules in
[AGENTS.md](AGENTS.md). Report security issues privately: [SECURITY.md](SECURITY.md).

## License

Apache-2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)). Code-OSS is MIT-licensed by Microsoft.
