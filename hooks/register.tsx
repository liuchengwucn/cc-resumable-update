import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Notice, Summary, Upgrade } from '../types'

const RELEASES = 'https://downloads.claude.ai/claude-code-releases'
const CHANGELOG_URL = 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md'
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const VERSION = /^\d+\.\d+\.\d+$/
const MiB = 1024 * 1024
const PANE = 'cc-resumable-update'
// Consecutive curl attempts that add no bytes before the download gives up.
const MAX_IDLE_ATTEMPTS = 5
// Changelog text handed to the model, at most.
const MAX_NOTES_CHARS = 150_000

const notice = atom({ plugin: 'cc-resumable-update', key: 'notice' } as const, null)
const upgrade = atom({ plugin: 'cc-resumable-update', key: 'upgrade' } as const, null)
const summary = atom({ plugin: 'cc-resumable-update', key: 'summary' } as const, null)

type Channel = 'stable' | 'latest'

// Where the native installer keeps versions, and the tools found on this machine.
type Machine = {
  os: 'unix' | 'windows'
  plat: string
  home: string
  // $XDG_DATA_HOME, or ~/.local/share: where the installer keeps claude/versions.
  data: string
  hasZstd: boolean
  sha: readonly string[]
}

// `other` is a system neither probe recognized: it upgrades through
// `claude install` alone, without a resumable download.
type Host = Machine | { os: 'other' }

// Windows file operations go through PowerShell, their paths through the
// environment (CRU_A, CRU_B), so no path needs quoting.
const PS = ['powershell', '-NoProfile', '-NonInteractive', '-Command'] as const

type Entry = { binary: string; checksum: string; size: number }

let channel: Channel = 'stable'
let host: Host | null = null
let checkInFlight: Promise<string> | null = null
let summaryInFlight = ''
let isCancelled = false

function isNewer(a: string, b: string): boolean {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i]
  }
  return false
}

function after($: EngineInterface, ms: number): Promise<void> {
  return new Promise(resolve => {
    $.clock.after(ms, resolve)
  })
}

async function getHost($: EngineInterface): Promise<Host> {
  if (host) return host

  let uname = ''
  try {
    const r = await $.process.run(['uname', '-sm'])
    if (r.exitCode === 0) uname = r.stdout.trim()
  } catch {
    uname = ''
  }
  const [sys, mach] = uname.split(/\s+/)
  if (sys !== 'Linux' && sys !== 'Darwin') {
    host = await getWindows($)
    return host
  }

  const probe = await $.process.run([
    'sh',
    '-c',
    'printf "%s\\n%s\\n" "$HOME" "${XDG_DATA_HOME:-$HOME/.local/share}"; command -v zstd >/dev/null && echo zstd; ' +
      'command -v sha256sum >/dev/null && echo sha256sum; ' +
      '{ ldd --version 2>&1 | grep -qi musl; } && echo musl; true',
  ])
  const [home, data, ...flags] = probe.stdout.split('\n').map(s => s.trim())
  const arch = /^(aarch64|arm64)$/.test(mach ?? '') ? 'arm64' : 'x64'
  const musl = flags.includes('musl') ? '-musl' : ''

  host = {
    os: 'unix',
    plat: `${sys === 'Darwin' ? 'darwin' : 'linux'}-${arch}${musl}`,
    home,
    data,
    hasZstd: flags.includes('zstd'),
    sha: flags.includes('sha256sum') ? ['sha256sum'] : ['shasum', '-a', '256'],
  }
  return host
}

// Windows has no `uname`; PowerShell answers the same questions there.
async function getWindows($: EngineInterface): Promise<Host> {
  let lines: string[] = []
  try {
    const r = await $.process.run([
      ...PS,
      "$env:USERPROFILE; if ($env:XDG_DATA_HOME) { $env:XDG_DATA_HOME } else { Join-Path $env:USERPROFILE '.local\\share' }; " +
        '"$env:PROCESSOR_ARCHITECTURE $env:PROCESSOR_ARCHITEW6432"; ' +
        "if (Get-Command zstd -ErrorAction SilentlyContinue) { 'zstd' }",
    ])
    if (r.exitCode === 0) lines = r.stdout.split(/\r?\n/).map(s => s.trim())
  } catch {
    lines = []
  }
  const [home, data, arch, ...flags] = lines
  if (!home || !data) return { os: 'other' }

  return {
    os: 'windows',
    plat: `win32-${/ARM64/i.test(arch ?? '') ? 'arm64' : 'x64'}`,
    home,
    data,
    hasZstd: flags.includes('zstd'),
    sha: [],
  }
}

function join(m: Machine, ...parts: string[]): string {
  return parts.join(m.os === 'windows' ? '\\' : '/')
}

function versionsDir(m: Machine): string {
  return join(m, m.data, 'claude', 'versions')
}

function claudeBin(m: Machine): string {
  return m.os === 'windows' ? join(m, m.home, '.local', 'bin', 'claude.exe') : join(m, m.home, '.local', 'bin', 'claude')
}

async function entryOf($: EngineInterface, url: string, plat: string): Promise<Entry | null> {
  const res = await $.http.fetch(url)
  if (!res.ok) return null
  const p = JSON.parse(res.text)?.platforms?.[plat]
  return typeof p?.binary === 'string' && typeof p?.checksum === 'string' && typeof p?.size === 'number'
    ? { binary: p.binary, checksum: p.checksum, size: p.size }
    : null
}

async function sizeOf($: EngineInterface, path: string): Promise<number> {
  return $.fs.stat(path).then(s => s.size, () => 0)
}

async function sha256($: EngineInterface, m: Machine, path: string): Promise<string> {
  const r =
    m.os === 'windows'
      ? await $.process.run([...PS, '(Get-FileHash -Algorithm SHA256 -LiteralPath $env:CRU_A).Hash'], {
          env: { CRU_A: path },
          timeoutMs: 300_000,
        })
      : await $.process.run([...m.sha, path], { timeoutMs: 300_000 })
  return r.exitCode === 0 ? r.stdout.trim().split(/\s+/)[0].toLowerCase() : ''
}

async function makeDir($: EngineInterface, m: Machine, dir: string): Promise<void> {
  await (m.os === 'windows'
    ? $.process.run([...PS, 'New-Item -ItemType Directory -Force -Path $env:CRU_A | Out-Null'], { env: { CRU_A: dir } })
    : $.process.run(['mkdir', '-p', dir]))
}

async function removeFiles($: EngineInterface, m: Machine, ...paths: string[]): Promise<void> {
  if (m.os !== 'windows') {
    await $.process.run(['rm', '-f', ...paths])
    return
  }
  for (const path of paths) {
    await $.process.run([...PS, 'Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $env:CRU_A'], {
      env: { CRU_A: path },
    })
  }
}

async function unpack($: EngineInterface, m: Machine, src: string, dst: string): Promise<boolean> {
  // On Unix through redirection, not path arguments: some zstd wrappers do not map paths.
  const r =
    m.os === 'windows'
      ? await $.process.run(['zstd', '-q', '-d', '-f', src, '-o', dst], { timeoutMs: 300_000 })
      : await $.process.run(['sh', '-c', 'zstd -q -d <"$1" >"$2"', '_', src, dst], { timeoutMs: 300_000 })
  return r.exitCode === 0
}

// Moves the verified binary into place. The installer takes a retained version
// only when it is executable, hence the chmod on Unix.
async function moveInto($: EngineInterface, m: Machine, src: string, dst: string): Promise<string> {
  const r =
    m.os === 'windows'
      ? await $.process.run([...PS, 'Move-Item -Force -LiteralPath $env:CRU_A -Destination $env:CRU_B'], {
          env: { CRU_A: src, CRU_B: dst },
        })
      : await $.process.run(['sh', '-c', 'mv -f "$1" "$2" && chmod 755 "$2"', '_', src, dst])
  return r.exitCode === 0 ? '' : r.stderr.trim() || 'could not move the binary into place'
}

// The download a confirm names: the compressed build when zstd is here.
async function plan($: EngineInterface, m: Machine, v: string) {
  const raw = await entryOf($, `${RELEASES}/${v}/manifest.json`, m.plat)
  if (raw === null) throw new Error(`no ${m.plat} build listed for ${v}`)
  const zst = m.hasZstd ? await entryOf($, `${RELEASES}/${v}/manifest.zst.json`, m.plat) : null
  const dir = versionsDir(m)
  const out = join(m, dir, v)
  const isReady = (await sizeOf($, out)) === raw.size && (await sha256($, m, out)) === raw.checksum
  const file = zst ?? raw

  return {
    raw,
    out,
    isReady,
    file,
    url: `${RELEASES}/${v}/${m.plat}/${file.binary}`,
    tmp: join(m, dir, `.${v}.${m.plat}${zst ? '.zst' : ''}.partial`),
  }
}

// Checks the channel against the running version; resolves a one-line summary.
// Joins a check already running, so two callers never toast twice.
function check($: EngineInterface): Promise<string> {
  checkInFlight ??= runCheck($).finally(() => {
    checkInFlight = null
  })
  return checkInFlight
}

// Sets the notice; the upgrade row stays while it is for the same version, or running.
async function setNotice($: EngineInterface, next: Notice | null): Promise<void> {
  await update($, notice, () => next)
  await update($, upgrade, u => (u?.phase === 'running' || u?.version === next?.target ? u : null))
}

async function runCheck($: EngineInterface): Promise<string> {
  const { base, version } = await $.session.version()
  const current = (base ?? version).replace(/-.*$/, '')
  const res = await $.http.fetch(`${RELEASES}/${channel}`)
  const target = res.text.trim()

  if (!res.ok || !VERSION.test(target)) {
    return `Could not read the ${channel} channel (HTTP ${res.status})`
  }

  if (!isNewer(target, current) || (await $.store.get('skipped')) === target) {
    await setNotice($, null)
    return `Claude Code ${current} is up to date (${channel}: ${target})`
  }

  const h = await getHost($)
  const isNative =
    h.os === 'other' || (await $.fs.exists(join(h, versionsDir(h), current)).catch(() => false))
  await setNotice($, { target, current, isNative })
  $.clock.after(1, () => {
    void summarize($, current, target).catch(() => undefined)
  })

  if ((await $.store.get('toasted')) !== target) {
    await $.store.set('toasted', target)
    $.ui.toast(`Claude Code ${target} is out on ${channel}`, { timeoutMs: 8000 })
  }

  return `Claude Code ${target} is available on ${channel} (you have ${current})`
}

// The changelog sections after `from`, up to and including `to`.
function notesBetween(changelog: string, from: string, to: string): string {
  return changelog
    .split(/^## /m)
    .slice(1)
    .filter(part => {
      const v = part.split('\n', 1)[0].trim()
      return VERSION.test(v) && isNewer(v, from) && !isNewer(v, to)
    })
    .map(part => `## ${part.trim()}`)
    .join('\n\n')
    .slice(0, MAX_NOTES_CHARS)
}

// Summarizes the changelog between two versions with Haiku, in the person's
// `language` setting, once per pair of versions.
async function summarize($: EngineInterface, from: string, to: string): Promise<void> {
  const key = `summary:${from}..${to}`
  const cached = await $.store.get(key)
  if (typeof cached === 'string') {
    await update($, summary, () => ({ from, to, status: 'ready', text: cached }))
    return
  }
  if (summaryInFlight === key) return
  summaryInFlight = key

  const set = (s: Summary) => update($, summary, () => s)
  try {
    await set({ from, to, status: 'pending', text: '' })
    const res = await $.http.fetch(CHANGELOG_URL)
    const notes = res.ok ? notesBetween(res.text, from, to) : ''
    if (notes === '') {
      await set({ from, to, status: 'failed', text: `No changelog entries found for ${from} → ${to} yet.` })
      return
    }

    const language = await $.settings.read({ key: 'language' })
    const r = await $.model.complete({
      model: 'haiku',
      maxTokens: 2000,
      system:
        'You summarize Claude Code release notes for someone who uses Claude Code daily in the terminal. ' +
        `Write in ${typeof language === 'string' && language ? language : 'English'}. ` +
        'Group the points under three short labels: new features, notable fixes, and changes that may ' +
        'affect existing workflows (left out when empty). Use "- " bullets, at most 15 in all, one line each. ' +
        'Skip minor or internal fixes. Plain text only: no markdown headings, bold or tables.',
      prompt: `Release notes from ${from} (exclusive) to ${to} (inclusive):\n\n${notes}`,
    })

    if (r.isAnswered) {
      await $.store.set(key, r.text.trim())
      await set({ from, to, status: 'ready', text: r.text.trim() })
    } else {
      await set({ from, to, status: 'failed', text: `The summary could not be written (${r.reason}).` })
    }
  } finally {
    summaryInFlight = ''
  }
}

// Shows the size of the download, so the person confirms knowing what it costs.
async function askConfirm($: EngineInterface, n: Notice): Promise<void> {
  const v = n.target
  const h = await getHost($)
  let downloadMiB: number | null = null
  let isCompressed = false

  if (h.os !== 'other') {
    try {
      const p = await plan($, h, v)
      isCompressed = p.file !== p.raw
      downloadMiB = p.isReady ? 0 : Math.max(0, p.file.size - (await sizeOf($, p.tmp))) / MiB
    } catch {
      downloadMiB = null
    }
  }

  await update($, upgrade, () => ({ phase: 'confirm', version: v, downloadMiB, isCompressed }))
}

// Downloads `url` into `tmp` with resume until it holds `size` bytes.
// Resolves `ok`, `cancelled`, or why it gave up.
async function download(
  $: EngineInterface,
  m: Machine,
  url: string,
  tmp: string,
  size: number,
  show: (bytes: number) => Promise<void>,
): Promise<string> {
  let idle = 0

  for (;;) {
    const have = await sizeOf($, tmp)
    if (have >= size) return 'ok'
    if (isCancelled) return 'cancelled'

    // --speed-limit/--speed-time: under 1 KB/s for 30 s counts as stalled, so curl
    // exits and the next attempt resumes. --progress-bar keeps chunks coming,
    // which is when the loop redraws and sees a cancel.
    const child = $.process.spawn({
      argv: [m.os === 'windows' ? 'curl.exe' : 'curl', '-fL', '-C', '-', '--speed-limit', '1024', '--speed-time', '30', '--progress-bar', '-o', tmp, url],
    })
    let lastDrawn = 0
    let error = ''

    try {
      for await (const { stream, text } of child) {
        if (isCancelled) break
        if (stream === 'stderr' && text.includes('curl: (')) error = text.trim()
        const now = await $.clock.now()
        if (now - lastDrawn > 500) {
          lastDrawn = now
          await show(await sizeOf($, tmp))
        }
      }
    } catch (err) {
      error = String(err)
    }
    if (isCancelled) return 'cancelled'

    const ended = await child.result.catch(() => ({ code: null, signal: null }))
    const now = await sizeOf($, tmp)
    await show(now)
    if (ended.code === 0 && now >= size) return 'ok'

    idle = now > have ? 0 : idle + 1
    if (idle >= MAX_IDLE_ATTEMPTS) return error || `curl exited with ${ended.code ?? ended.signal}`
    await after($, 5000)
  }
}

// Leaves a verified binary at `versions/<v>`, where `claude install <v>` takes it
// as already downloaded. Resolves `ok`, `cancelled`, or why it stopped.
async function fetchBinary($: EngineInterface, m: Machine, v: string): Promise<string> {
  const p = await plan($, m, v)
  if (p.isReady) return 'ok'

  const running = (stage: 'download' | 'verify' | 'unpack', done: number) =>
    update($, upgrade, () => ({
      phase: 'running',
      version: v,
      stage,
      doneMiB: done / MiB,
      totalMiB: p.file.size / MiB,
      line: '',
    }))

  await makeDir($, m, versionsDir(m))
  const got = await download($, m, p.url, p.tmp, p.file.size, bytes => running('download', bytes))
  if (got !== 'ok') return got

  await running('verify', p.file.size)
  if ((await sha256($, m, p.tmp)) !== p.file.checksum) {
    await removeFiles($, m, p.tmp)
    return 'checksum mismatch on the download; it was removed, retry to download again'
  }

  let unpacked = p.tmp
  if (p.file !== p.raw) {
    await running('unpack', p.file.size)
    unpacked = join(m, versionsDir(m), `.${v}.${m.plat}.unpacked`)
    if (!(await unpack($, m, p.tmp, unpacked)) || (await sha256($, m, unpacked)) !== p.raw.checksum) {
      await removeFiles($, m, p.tmp, unpacked)
      return 'the unpacked binary did not verify; the download was removed, retry to download again'
    }
    await removeFiles($, m, p.tmp)
  }

  return (await moveInto($, m, unpacked, p.out)) || 'ok'
}

// Runs `claude install <v>` and resolves its exit code and last line.
async function install($: EngineInterface, h: Host, v: string): Promise<{ code: number | null; line: string }> {
  const bin = h.os !== 'other' && (await $.fs.exists(claudeBin(h))) ? claudeBin(h) : 'claude'
  const child = $.process.spawn({ argv: [bin, 'install', v] })
  let line = ''

  for await (const { text } of child) {
    const lines = text.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean)
    if (lines.length > 0) {
      line = lines[lines.length - 1]
      await update($, upgrade, u => (u?.phase === 'running' ? { ...u, line } : u))
    }
  }
  const ended = await child.result.catch(() => ({ code: null, signal: null }))
  return { code: ended.code, line }
}

async function runUpgrade($: EngineInterface, n: Notice): Promise<void> {
  const v = n.target
  isCancelled = false
  const failed = (line: string) => update($, upgrade, () => ({ phase: 'failed', version: v, line }))

  try {
    const h = await getHost($)
    if (h.os !== 'other') {
      const got = await fetchBinary($, h, v)
      if (got === 'cancelled') return void (await failed('Cancelled. What was downloaded is kept; retry resumes it.'))
      if (got !== 'ok') return void (await failed(got))
    }

    await update($, upgrade, () => ({
      phase: 'running',
      version: v,
      stage: 'install',
      doneMiB: 0,
      totalMiB: 0,
      line: `claude install ${v}`,
    }))
    const { code, line } = await install($, h, v)
    await update($, upgrade, () =>
      code === 0 ? { phase: 'done', version: v } : { phase: 'failed', version: v, line: line || `claude install exited with ${code}` },
    )
  } catch (err) {
    await failed(String(err))
  }
}

function runningText(u: Upgrade & { phase: 'running' }): string {
  if (u.stage === 'download') return `Downloading ${u.doneMiB.toFixed(1)} / ${u.totalMiB.toFixed(1)} MiB`
  if (u.stage === 'verify') return 'Verifying checksum…'
  if (u.stage === 'unpack') return 'Unpacking…'
  return `Installing… ${u.line}`
}

export const register: Register = (on, options) => {
  channel = options.channel === 'latest' ? 'latest' : 'stable'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'check-update',
      description: 'Check for a new Claude Code release now (and stop skipping any version)',
    })
    void check($).catch(() => undefined)
    $.clock.every(CHECK_EVERY_MS, () => {
      void check($).catch(() => undefined)
    })

    return next(e)
  })

  on('command.run', { command: 'check-update' }, async $ => {
    await $.store.delete('skipped')
    const text = await check($).catch(err => `Check failed: ${String(err)}`)

    return { text }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const n = await read($, notice)

    if (n === null || e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const u = await read($, upgrade)
    const s = await read($, summary)
    const v = n.target
    const room = Math.max(20, e.props.bodyColumns - 30)
    const close = async () => {
      await update($, upgrade, () => null)
      await update($, notice, () => null)
    }
    const whatsNew =
      s?.to === v && s.status !== 'pending' ? (
        <Button key="news" label="What's new" onPress={() => $.ui.open({ id: PANE, title: `Claude Code ${s.from} → ${s.to}` })} />
      ) : (
        <Text dimColor>Summarizing changes…</Text>
      )

    let row
    if (u === null && !n.isNative) {
      row = (
        <Box>
          <Text>Installed by a package manager: run `claude update`. </Text>
          {whatsNew}
          <Text> </Text>
          <Button key="skip" label="Skip this version" onPress={async () => { await $.store.set('skipped', v); await close() }} />
        </Box>
      )
    } else if (u === null) {
      row = (
        <Box>
          <Button key="upgrade" label="Upgrade" variant="primary" onPress={() => askConfirm($, n)} />
          <Text> </Text>
          {whatsNew}
          <Text> </Text>
          <Button key="skip" label="Skip this version" onPress={async () => { await $.store.set('skipped', v); await close() }} />
        </Box>
      )
    } else if (u.phase === 'confirm') {
      const size =
        u.downloadMiB === null
          ? 'Download size unknown.'
          : u.downloadMiB === 0
            ? 'Already downloaded.'
            : `Downloads ${u.downloadMiB.toFixed(0)} MiB${u.isCompressed ? ' (zstd)' : ''}, resumable.`
      row = (
        <Box>
          <Text>Install {v}? {size} </Text>
          <Button key="confirm" label="Install" variant="primary" onPress={() => { $.clock.after(1, () => void runUpgrade($, n)) }} />
          <Text> </Text>
          <Button key="cancel" label="Cancel" onPress={() => update($, upgrade, () => null)} />
        </Box>
      )
    } else if (u.phase === 'running') {
      row = (
        <Box>
          <Text color="cyan">{runningText(u).slice(0, room)} </Text>
          {u.stage === 'download' && (
            <Button key="abort" label="Cancel" onPress={() => { isCancelled = true }} />
          )}
        </Box>
      )
    } else if (u.phase === 'done') {
      row = (
        <Box>
          <Text color="green">✓ Installed {v}. Restart claude to use it. </Text>
          <Button key="close" label="Close" onPress={close} />
        </Box>
      )
    } else {
      row = (
        <Box>
          <Text color="red">✗ Upgrade stopped: {u.line.slice(0, room)} </Text>
          <Button key="retry" label="Retry" variant="primary" onPress={() => { $.clock.after(1, () => void runUpgrade($, n)) }} />
          <Text> </Text>
          <Button key="close" label="Close" onPress={close} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text color="yellow">
          ⬆ Claude Code {v} is available on {channel} (you have {n.current})
        </Text>
        {row}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, summary)

    return (
      <Box flexDirection="column">
        {s === null && <Text dimColor>No release to summarize.</Text>}
        {s?.status === 'pending' && <Text dimColor>Summarizing {s.from} → {s.to}…</Text>}
        {s !== null && s.status !== 'pending' && s.text.split('\n').map(line => <Text>{line}</Text>)}
        {s !== null && <Text dimColor>Full changelog: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md</Text>}
      </Box>
    )
  })
}
