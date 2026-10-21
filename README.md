# cc-resumable-update

English | [简体中文](README.zh-CN.md)

A Claude Code mod for people who keep auto-updates off but still want to hear
about new releases.

- **Notifies you** with a band above the prompt when a newer release is out on
  your channel (`stable` by default), checking at startup and every 6 hours.
- **Summarizes what changed** between your version and the new one: the
  changelog entries in between, condensed by Haiku in the language your
  `language` setting names.
- **Upgrades with one button**, through a download that resumes where it left
  off. A dropped connection costs only the bytes still missing, never the whole
  binary again.

Nothing installs without your click: the band shows the download size first and
asks you to confirm.

## Why

Claude Code's own installer (as of 2.1.304) restarts a failed download from zero.
On a slow or metered connection, one drop late in the download wastes all of it.
This mod downloads with `curl -C -` instead, checks the result against the
release manifest, and then hands it to `claude install <version>`, which links
the verified binary without downloading it again.

## Install

At the prompt of a terminal session:

```
/plugin install cc-resumable-update --marketplace liuchengwucn/cc-resumable-update
```

## Use

- The band appears on its own when a release is out. **Upgrade** shows the size
  and asks to confirm; **What's new** opens the changelog summary in a pane;
  **Skip this version** hides the band until the next release.
- `/check-update` checks right away and clears a skipped version.

### Options

| Option | Values | Default |
| --- | --- | --- |
| `channel` | `stable`, `latest` | `stable` |

## How the upgrade works

1. Reads `manifest.json` (and `manifest.zst.json` when `zstd` is on your `PATH`)
   for your platform's checksum and size.
2. Downloads the zstd build (about a third of the size), or the plain binary
   without `zstd`, into the installer's versions folder,
   `$XDG_DATA_HOME/claude/versions/` (by default `~/.local/share/claude/versions/`,
   `%USERPROFILE%\.local\share\claude\versions\` on Windows), as
   `.<version>.<platform>[.zst].partial`. A partial file already there is resumed,
   and a lock keeps two Claude Code sessions from downloading the same version
   at once.
3. Checks the download's SHA-256 against the manifest, unpacks it, and checks
   the unpacked binary's SHA-256 too. A download that fails its check is
   deleted; one that passed is kept when unpacking fails, so a retry only
   unpacks it again.
4. Moves it to `<version>` in that folder (marked executable on macOS and
   Linux) and runs `claude install <version>`. Once it succeeds, partial files
   left from other versions are removed.

Installs made by a package manager (Homebrew, npm, WinGet) get the notice and
the summary but no Upgrade button. The band tells you to run `claude update`.

### Requirements

- **macOS and Linux:** `curl`, plus `sha256sum` or `shasum`.
- **Windows:** `curl.exe` (built into Windows 10 1803 and later) and Windows
  PowerShell, which hashes and moves the files.
- **Optional everywhere:** `zstd` on your `PATH`, which cuts the download to
  about a third.

### Caveat

Step 4 relies on the native installer reusing a binary it finds already in its
versions folder with the right checksum. That behavior is undocumented. The
[`installer-reuse`](.github/workflows/installer-reuse.yml) workflow checks it
weekly on Windows, macOS and Linux, and every upgrade checks it too: when
`claude install` replaces the binary instead of reusing it, the band says so
once the install finishes. The upgrade still succeeds then, but costs the full
download.

## Network and privacy

- `downloads.claude.ai`: channel pointers, manifests and binaries.
- `raw.githubusercontent.com`: the public Claude Code changelog.
- One Haiku call per new release, made through your own Claude Code session.
  The result is cached, so the same pair of versions is never summarized twice.

## License

MIT
