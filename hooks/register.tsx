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
// A download lock whose partial file has not grown for this long is taken to be
// left by a session that exited, and is taken over.
const STALE_LOCK_MS = 2 * 60 * 1000
// What this mod leaves in the versions folder while it works.
const LEFTOVER = /^\.\d+\.\d+\.\d+\..+\.(partial|unpacked)$/

const notice = atom({ plugin: 'cc-resumable-update', key: 'notice' } as const, null)
const upgrade = atom({ plugin: 'cc-resumable-update', key: 'upgrade' } as const, null)
const summary = atom({ plugin: 'cc-resumable-update', key: 'summary' } as const, null)

type Channel = 'stable' | 'latest'

// A command to run without a shell, and the environment it needs.
type Cmd = { argv: readonly string[]; env?: Record<string, string> }

// The commands for each file operation on one operating system.
type Commands = {
  curl: string
  sha256: (path: string) => Cmd
  makeDir: (dir: string) => Cmd
  // Creates `dir`, failing when it exists: an atomic lock.
  lock: (dir: string) => Cmd
  unlock: (dir: string) => Cmd
  remove: (path: string) => Cmd
  unpack: (src: string, dst: string) => Cmd
  // Moves the verified binary into place. The installer takes a retained
  // version only when it is executable, hence the chmod on Unix.
  move: (src: string, dst: string) => Cmd
}

function unixCommands(sha: readonly string[]): Commands {
  return {
    curl: 'curl',
    sha256: path => ({ argv: [...sha, path] }),
    makeDir: dir => ({ argv: ['mkdir', '-p', dir] }),
    lock: dir => ({ argv: ['mkdir', dir] }),
    unlock: dir => ({ argv: ['rmdir', dir] }),
    remove: path => ({ argv: ['rm', '-f', path] }),
    // Through redirection, not path arguments: some zstd wrappers do not map paths.
    unpack: (src, dst) => ({ argv: ['sh', '-c', 'zstd -q -d <"$1" >"$2"', '_', src, dst] }),
    move: (src, dst) => ({ argv: ['sh', '-c', 'mv -f "$1" "$2" && chmod 755 "$2"', '_', src, dst] }),
  }
}

// Windows file operations go through PowerShell with their paths in the
// environment (CRU_A, CRU_B), so no path needs quoting. The scripts hold no
// double quotes: Windows argument quoting does not carry them reliably.
function powershell(script: string, a: string, b = ''): Cmd {
  return { argv: ['powershell', '-NoProfile', '-NonInteractive', '-Command', script], env: { CRU_A: a, CRU_B: b } }
}

const WINDOWS: Commands = {
  curl: 'curl.exe',
  sha256: path => powershell('(Get-FileHash -Algorithm SHA256 -LiteralPath $env:CRU_A).Hash', path),
  makeDir: dir => powershell('New-Item -ItemType Directory -Force -Path $env:CRU_A | Out-Null', dir),
  lock: dir => powershell('New-Item -ItemType Directory -Path $env:CRU_A -ErrorAction Stop | Out-Null', dir),
  unlock: dir => powershell('Remove-Item -Force -LiteralPath $env:CRU_A', dir),
  remove: path => powershell('Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $env:CRU_A', path),
  unpack: (src, dst) => ({ argv: ['zstd', '-q', '-d', '-f', src, '-o', dst] }),
  move: (src, dst) => powershell('Move-Item -Force -LiteralPath $env:CRU_A -Destination $env:CRU_B', src, dst),
}

// Where the native installer keeps versions, and how to work on files here.
type Machine = {
  plat: string
  sep: '/' | '\\'
  // $XDG_DATA_HOME, or ~/.local/share: where the installer keeps claude/versions.
  data: string
  // The native launcher, `claude install` runs through it.
  launcher: string
  hasZstd: boolean
  cmd: Commands
}

// `null`: a system this mod does not recognize, which upgrades through
// `claude install` alone, without a resumable download.
type Host = Machine | null

type Entry = { binary: string; checksum: string; size: number }

type Plan = {
  version: string
  raw: Entry
  file: Entry
  out: string
  url: string
  tmp: string
  isReady: boolean
}

let channel: Channel = 'stable'
let host: Host | undefined
let checkInFlight: Promise<string> | null = null
let summaryInFlight = ''
// One upgrade at a time in this session; isCancelled is its Cancel.
let isUpgrading = false
let isCancelled = false
// The plan Upgrade worked out, reused by Install.
let planned: Plan | null = null

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

async function run($: EngineInterface, c: Cmd, timeoutMs = 30_000) {
  try {
    return await $.process.run(c.argv, { env: c.env, timeoutMs })
  } catch (err) {
    return { exitCode: -1, stdout: '', stderr: String(err) }
  }
}

// Whether `argv` starts and exits 0: how a tool is found, as the mod runs it.
async function runs($: EngineInterface, argv: readonly string[]): Promise<boolean> {
  return (await run($, { argv })).exitCode === 0
}

async function getHost($: EngineInterface): Promise<Host> {
  if (host !== undefined) return host

  const uname = await run($, { argv: ['uname', '-sm'] })
  const [sys, mach] = uname.exitCode === 0 ? uname.stdout.trim().split(/\s+/) : []
  const hasZstd = await runs($, ['zstd', '--version'])

  if (sys === 'Linux' || sys === 'Darwin') {
    const home = (await $.env.get('HOME')) ?? ''
    const data = (await $.env.get('XDG_DATA_HOME')) || `${home}/.local/share`
    const ldd = sys === 'Linux' ? await run($, { argv: ['sh', '-c', 'ldd --version 2>&1'] }) : null
    const musl = /musl/i.test(ldd?.stdout ?? '') ? '-musl' : ''
    const sha = (await runs($, ['sha256sum', '--version'])) ? ['sha256sum'] : ['shasum', '-a', '256']
    host = {
      plat: `${sys === 'Darwin' ? 'darwin' : 'linux'}-${/^(aarch64|arm64)$/.test(mach ?? '') ? 'arm64' : 'x64'}${musl}`,
      sep: '/',
      data,
      launcher: `${home}/.local/bin/claude`,
      hasZstd,
      cmd: unixCommands(sha),
    }
    return host
  }

  // Windows has no `uname`. Paths come from the environment, never from a
  // child's output, which Windows PowerShell writes in the console code page.
  const profile = await $.env.get('USERPROFILE')
  if (!profile || (await $.env.get('OS')) !== 'Windows_NT') {
    host = null
    return host
  }
  const arch = `${(await $.env.get('PROCESSOR_ARCHITEW6432')) ?? ''} ${(await $.env.get('PROCESSOR_ARCHITECTURE')) ?? ''}`
  host = {
    plat: `win32-${/ARM64/i.test(arch) ? 'arm64' : 'x64'}`,
    sep: '\\',
    data: (await $.env.get('XDG_DATA_HOME')) || `${profile}\\.local\\share`,
    launcher: `${profile}\\.local\\bin\\claude.exe`,
    hasZstd,
    cmd: WINDOWS,
  }
  return host
}

function join(m: Machine, ...parts: string[]): string {
  return parts.join(m.sep)
}

function versionsDir(m: Machine): string {
  return join(m, m.data, 'claude', 'versions')
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

async function mtimeOf($: EngineInterface, path: string): Promise<number | null> {
  return $.fs.stat(path).then(s => s.mtimeMs, () => null)
}

// The file's SHA-256 in lower case, or null when the hashing tool failed.
async function sha256($: EngineInterface, m: Machine, path: string): Promise<string | null> {
  const r = await run($, m.cmd.sha256(path), 300_000)
  const hash = r.stdout.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  return r.exitCode === 0 && /^[0-9a-f]{64}$/.test(hash) ? hash : null
}

// The download for version `v`: the compressed build when zstd runs here.
async function plan($: EngineInterface, m: Machine, v: string): Promise<Plan> {
  const raw = await entryOf($, `${RELEASES}/${v}/manifest.json`, m.plat)
  if (raw === null) throw new Error(`no ${m.plat} build listed for ${v}`)
  const zst = m.hasZstd ? await entryOf($, `${RELEASES}/${v}/manifest.zst.json`, m.plat) : null
  const dir = versionsDir(m)
  const out = join(m, dir, v)
  const isReady = (await sizeOf($, out)) === raw.size && (await sha256($, m, out)) === raw.checksum
  const file = zst ?? raw

  return {
    version: v,
    raw,
    file,
    out,
    isReady,
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

// Sets the notice. An upgrade row stays while it runs or is for the new target.
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

  const m = await getHost($)
  // Installed by this mod and waiting for a restart: nothing more to offer.
  const isInstalled =
    m !== null &&
    (await $.store.get('installed')) === target &&
    (await $.fs.exists(join(m, versionsDir(m), target)).catch(() => false))
  if (isInstalled && (await read($, upgrade))?.phase !== 'done') {
    await setNotice($, null)
    return `Claude Code ${target} is installed; restart claude to use it`
  }

  if (!isNewer(target, current) || (await $.store.get('skipped')) === target) {
    await setNotice($, null)
    return `Claude Code ${current} is up to date (${channel}: ${target})`
  }

  const isNative = m === null || (await $.fs.exists(join(m, versionsDir(m), current)).catch(() => false))
  await setNotice($, { target, current, isNative })
  $.clock.after(1, () => {
    void summarize($, current, target)
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
      const why = res.ok ? `No changelog entries found for ${from} → ${to} yet.` : `Could not fetch the changelog (HTTP ${res.status}).`
      await set({ from, to, status: 'failed', text: why })
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
  } catch (err) {
    await set({ from, to, status: 'failed', text: `The summary could not be written (${String(err)}).` })
  } finally {
    summaryInFlight = ''
  }
}

// Works out the size of the download, so the person confirms knowing what it costs.
async function askConfirm($: EngineInterface, v: string): Promise<void> {
  await update($, upgrade, () => ({ phase: 'preparing', version: v }))
  const m = await getHost($)
  let downloadMiB: number | null = null
  let isCompressed = false
  planned = null

  if (m !== null) {
    try {
      planned = await plan($, m, v)
      isCompressed = planned.file !== planned.raw
      downloadMiB = planned.isReady ? 0 : Math.max(0, planned.file.size - (await sizeOf($, planned.tmp))) / MiB
    } catch {
      downloadMiB = null
    }
  }

  await update($, upgrade, u =>
    u?.phase === 'preparing' && u.version === v ? { phase: 'confirm', version: v, downloadMiB, isCompressed } : u,
  )
}

// Starts the upgrade on a timer of its own, outside the press's dispatch. The
// row shows it at once, so a second press finds no Install or Cancel to press.
async function startUpgrade($: EngineInterface, v: string): Promise<void> {
  if (isUpgrading) return
  isUpgrading = true
  isCancelled = false
  await update($, upgrade, () => ({
    phase: 'running',
    version: v,
    stage: 'prepare',
    doneMiB: 0,
    totalMiB: 0,
    line: '',
    isCancelling: false,
  }))
  $.clock.after(1, () => {
    void runUpgrade($, v).finally(() => {
      isUpgrading = false
    })
  })
}

async function cancelUpgrade($: EngineInterface): Promise<void> {
  isCancelled = true
  await update($, upgrade, u => (u?.phase === 'running' ? { ...u, isCancelling: true } : u))
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

    // --speed-limit/--speed-time: under 1 KB/s for 30 s counts as stalled, so
    // curl exits and the next attempt resumes. Each progress chunk is when the
    // loop redraws and sees a cancel; a stalled transfer writes none, so a
    // cancel then waits for curl to give up, 30 s at most.
    const child = $.process.spawn({
      argv: [m.cmd.curl, '-fL', '-C', '-', '--speed-limit', '1024', '--speed-time', '30', '--progress-bar', '-o', tmp, url],
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

// Takes the download lock of `tmp`, taking over one whose partial file has not
// grown for STALE_LOCK_MS. False when another session is downloading.
async function lock($: EngineInterface, m: Machine, tmp: string): Promise<boolean> {
  const dir = `${tmp}.lock`
  if ((await run($, m.cmd.lock(dir))).exitCode === 0) return true

  const now = await $.clock.now()
  const touched = Math.max((await mtimeOf($, dir)) ?? 0, (await mtimeOf($, tmp)) ?? 0)
  if (now - touched < STALE_LOCK_MS) return false

  await run($, m.cmd.unlock(dir))
  return (await run($, m.cmd.lock(dir))).exitCode === 0
}

// Leaves a verified binary at `versions/<v>`, where `claude install <v>` takes it
// as already downloaded. Resolves `ok`, `cancelled`, or why it stopped.
async function fetchBinary($: EngineInterface, m: Machine, v: string): Promise<string> {
  const p = planned?.version === v ? planned : await plan($, m, v)
  planned = null
  if (p.isReady) return 'ok'

  const running = (stage: 'download' | 'verify' | 'unpack', done: number) =>
    update($, upgrade, u =>
      u?.phase === 'running'
        ? { ...u, stage, doneMiB: done / MiB, totalMiB: p.file.size / MiB, line: '' }
        : u,
    )

  await run($, m.cmd.makeDir(versionsDir(m)))
  if (!(await lock($, m, p.tmp))) {
    return 'another Claude Code session is downloading this version; retry once it is done'
  }

  try {
    const got = await download($, m, p.url, p.tmp, p.file.size, bytes => running('download', bytes))
    if (got !== 'ok') return got

    await running('verify', p.file.size)
    const hash = await sha256($, m, p.tmp)
    if (hash === null) return 'could not compute the checksum of the download; it is kept, retry checks it again'
    if (hash !== p.file.checksum) {
      await run($, m.cmd.remove(p.tmp))
      return 'checksum mismatch on the download; it was removed, retry to download again'
    }

    let unpacked = p.tmp
    if (p.file !== p.raw) {
      await running('unpack', p.file.size)
      unpacked = join(m, versionsDir(m), `.${v}.${m.plat}.unpacked`)
      const isUnpacked = (await run($, m.cmd.unpack(p.tmp, unpacked), 300_000)).exitCode === 0
      if (!isUnpacked || (await sha256($, m, unpacked)) !== p.raw.checksum) {
        // The download verified, so it stays: a retry unpacks it again.
        await run($, m.cmd.remove(unpacked))
        return 'unpacking did not give the expected binary (is the disk full?); the download is kept, retry unpacks it again'
      }
      await run($, m.cmd.remove(p.tmp))
    }

    const moved = await run($, m.cmd.move(unpacked, p.out))
    return moved.exitCode === 0 ? 'ok' : moved.stderr.trim() || 'could not move the binary into place'
  } finally {
    await run($, m.cmd.unlock(`${p.tmp}.lock`))
  }
}

// Removes what this mod left in the versions folder for other versions.
async function cleanUp($: EngineInterface, m: Machine): Promise<void> {
  const entries = await $.fs.list(versionsDir(m)).catch(() => [])
  for (const e of entries) {
    if (e.kind === 'file' && LEFTOVER.test(e.name)) await run($, m.cmd.remove(join(m, versionsDir(m), e.name)))
  }
}

// Runs `claude install <v>` and resolves its exit code and last line.
async function install($: EngineInterface, m: Host, v: string): Promise<{ code: number | null; line: string }> {
  const bin = m !== null && (await $.fs.exists(m.launcher)) ? m.launcher : 'claude'
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

async function runUpgrade($: EngineInterface, v: string): Promise<void> {
  const failed = (line: string) => update($, upgrade, () => ({ phase: 'failed', version: v, line }))

  try {
    const m = await getHost($)
    if (m !== null) {
      const got = await fetchBinary($, m, v)
      if (got === 'cancelled') return void (await failed('Cancelled. What was downloaded is kept; retry resumes it.'))
      if (got !== 'ok') return void (await failed(got))
    }

    await update($, upgrade, u =>
      u?.phase === 'running' ? { ...u, stage: 'install', line: `claude install ${v}`, isCancelling: false } : u,
    )
    // The installer reuses the binary placed here, leaving its mtime as it was.
    // A changed mtime means it downloaded the binary again.
    const placed = m === null ? null : join(m, versionsDir(m), v)
    const before = placed ? await mtimeOf($, placed) : null
    const { code, line } = await install($, m, v)
    if (code !== 0) return void (await failed(line || `claude install exited with ${code}`))

    const isRedownloaded = placed !== null && before !== null && (await mtimeOf($, placed)) !== before
    await $.store.set('installed', v)
    if (m !== null) await cleanUp($, m)
    await update($, upgrade, () => ({ phase: 'done', version: v, isRedownloaded }))
  } catch (err) {
    await failed(String(err))
  }
}

function runningText(u: Upgrade & { phase: 'running' }): string {
  if (u.isCancelling) return 'Cancelling… (up to 30 s while the connection is stalled)'
  if (u.stage === 'prepare') return 'Preparing…'
  if (u.stage === 'download') return `Downloading ${u.doneMiB.toFixed(1)} / ${u.totalMiB.toFixed(1)} MiB`
  if (u.stage === 'verify') return 'Verifying checksum…'
  if (u.stage === 'unpack') return 'Unpacking…'
  return `Installing… ${u.line}`
}

function sizeText(downloadMiB: number | null, isCompressed: boolean): string {
  if (downloadMiB === null) return 'Download size unknown.'
  if (downloadMiB === 0) return 'Already downloaded.'
  const size = downloadMiB.toFixed(downloadMiB < 10 ? 1 : 0)
  return `Downloads ${size} MiB${isCompressed ? ' (zstd)' : ''}, resumable.`
}

export const register: Register = (on, options) => {
  channel = options.channel === 'latest' ? 'latest' : 'stable'

  on('session.start', async ($, e, next) => {
    // A reload drops the running download with the old module: say so, so
    // the row offers Retry instead of a progress line nothing moves.
    await update($, upgrade, u =>
      u?.phase === 'running' || u?.phase === 'preparing'
        ? { phase: 'failed', version: u.version, line: 'Interrupted when the mod reloaded. Retry resumes the download.' }
        : u,
    )
    await $.command.register({
      name: 'check-update',
      description: 'Check for a new Claude Code release now (and stop skipping any version)',
    })

    // `claude -p` and SDK runs show no band: they would only spend the toast.
    if (e.isInteractive) {
      void check($).catch(() => undefined)
      $.clock.every(CHECK_EVERY_MS, () => {
        void check($).catch(() => undefined)
      })
    }

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
    const room = Math.max(20, e.props.bodyColumns - 30)
    const close = async () => {
      await update($, upgrade, () => null)
      await update($, notice, () => null)
    }
    const skip = async () => {
      await $.store.set('skipped', n.target)
      await close()
    }
    const whatsNew =
      s?.to === n.target && s.status !== 'pending' ? (
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
          <Button key="skip" label="Skip this version" onPress={skip} />
        </Box>
      )
    } else if (u === null) {
      row = (
        <Box>
          <Button key="upgrade" label="Upgrade" variant="primary" onPress={() => askConfirm($, n.target)} />
          <Text> </Text>
          {whatsNew}
          <Text> </Text>
          <Button key="skip" label="Skip this version" onPress={skip} />
        </Box>
      )
    } else if (u.phase === 'preparing') {
      row = <Text dimColor>Checking the download size of {u.version}…</Text>
    } else if (u.phase === 'confirm') {
      row = (
        <Box>
          <Text>Install {u.version}? {sizeText(u.downloadMiB, u.isCompressed)} </Text>
          <Button key="confirm" label="Install" variant="primary" onPress={() => startUpgrade($, u.version)} />
          <Text> </Text>
          <Button key="cancel" label="Cancel" onPress={() => update($, upgrade, () => null)} />
        </Box>
      )
    } else if (u.phase === 'running') {
      row = (
        <Box>
          <Text color="cyan">{runningText(u).slice(0, room)} </Text>
          {(u.stage === 'prepare' || u.stage === 'download') && !u.isCancelling && (
            <Button key="abort" label="Cancel" onPress={() => cancelUpgrade($)} />
          )}
        </Box>
      )
    } else if (u.phase === 'done') {
      row = (
        <Box flexDirection="column">
          <Box>
            <Text color="green">✓ Installed {u.version}. Restart claude to use it. </Text>
            <Button key="close" label="Close" onPress={close} />
          </Box>
          {u.isRedownloaded && (
            <Text color="yellow">
              Note: claude install downloaded the binary again instead of reusing the resumed download, so
              resuming saved nothing this time. Please report it at github.com/liuchengwucn/cc-resumable-update/issues
            </Text>
          )}
        </Box>
      )
    } else {
      row = (
        <Box>
          <Text color="red">✗ Upgrade stopped: {u.line.slice(0, room)} </Text>
          <Button key="retry" label="Retry" variant="primary" onPress={() => startUpgrade($, u.version)} />
          <Text> </Text>
          <Button key="close" label="Close" onPress={close} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text color="yellow">
          ⬆ Claude Code {n.target} is available on {channel} (you have {n.current})
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
