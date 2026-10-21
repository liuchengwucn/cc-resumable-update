# cc-resumable-update

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

On macOS and Linux:

1. Reads `manifest.json` (and `manifest.zst.json` when `zstd` is on your `PATH`)
   for your platform's checksum and size.
2. Downloads `claude.zst` (about a third of the size), or the plain binary
   without `zstd`, into `$XDG_DATA_HOME/claude/versions/` (default `~/.local/share/claude/versions/`) as `.<version>.<platform>.zst.partial`,
   resuming any partial file already there.
3. Checks the download's SHA-256 against the manifest, unpacks it, and checks
   the unpacked binary's SHA-256 too. A file that fails a check is deleted.
4. Moves it to `claude/versions/<version>` in that folder, marks it executable,
   and runs `claude install <version>`.

On Windows, and anywhere without `uname`, the upgrade runs `claude install
<version>` alone, so the download does not resume there yet.

Installs made by a package manager (Homebrew, npm, WinGet) get the notice and
the summary but no Upgrade button. The band tells you to run `claude update`.

### Requirements

`curl`, plus `sha256sum` or `shasum`. `zstd` is optional and cuts the download
to about a third.

### Caveat

Step 4 relies on the native installer reusing a binary it finds already in its
versions folder with the right checksum. That behavior is undocumented. If a
future release changes it, `claude install` downloads the binary again: the
upgrade still succeeds but costs the full download.

## Network and privacy

- `downloads.claude.ai`: channel pointers, manifests and binaries.
- `raw.githubusercontent.com`: the public Claude Code changelog.
- One Haiku call per new release, made through your own Claude Code session.
  The result is cached, so the same pair of versions is never summarized twice.

## License

MIT
