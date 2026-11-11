# dsh-studio-library

[简体中文](README.zh.md)

## Repository

- Repository name: `dsh-studio-library`
- Repository description: Installable DSH control bundle for studio discovery, project containers, service status, sessions and updates. Business studios remain optional.
- Source: `https://github.com/1997liuyh-boop/dsh-studio-library`

## Features

- `dsh-worktable`: studio list, control room, project container, split workspace and window layout.
- `dsh-studio-projects`: studio registration, page serving, local-service startup and health status, session tools, task expansion and update records.
- Project data and update records are isolated under `DSH_HOME/studio/<studio-id>/`.
- The root package bundles only the two control packages. It does not install business studios or private Live2D/Cubism assets.
- The root manifest declares `dsh.bundle.patch`; `packages/worktable` and `packages/runtime` retain their own package manifests and compiled Host/Client entries.

## Installation

Use the official Desktop plugin manager after fully quitting Desktop, or run the bundled carrier at `resources/runtime/cli/bin/dsh.cmd` on Windows. Install the control bundle and then only the business studios you need:

```powershell
& "<Desktop install directory>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "github:1997liuyh-boop/dsh-studio-library#v0.1.9"
& "<Desktop install directory>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop list
```

The first command installs `dsh-worktable` and `dsh-studio-projects`; an empty business-studio list is valid. Add a studio from its own README. Verify the installed package with `plugin --profile desktop list`; the manifest must contain `dsh.bundle.patch`, and the package must expose its declared `main` entry and patch file. Restart Desktop after package operations.

Git commits do not update an installed lockfile. Reinstall the exact tag when upgrading. Keep `DSH_HOME/studio/` before removing an older combined package, and install any business studios you want to keep before removing that package.

## Requirements and limits

Use DSH `0.2.2-rc.1` compatible builds and Node.js 22 for source builds. Local applications, OBS, external providers and model assets require their own setup. The public package contains no credentials, private model files or Cubism Core.

## License and sources

The project is MIT licensed. The worktable adaptation retains the upstream notices documented in `SDK-SNAPSHOT.json` and the repository files.
