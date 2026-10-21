import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/u'
const DIR = `${HOME}/.local/share/claude/versions`
const PLAT = 'linux-arm64'
const RAW = { binary: 'claude', checksum: 'r'.repeat(64), size: 300 * 1024 * 1024 }
const ZST = { binary: 'claude.zst', checksum: 'z'.repeat(64), size: 100 * 1024 * 1024 }
const ZTMP = `${DIR}/.2.1.310.${PLAT}.zst.partial`
const UNPACKED = `${DIR}/.2.1.310.${PLAT}.unpacked`
const OUT = `${DIR}/2.1.310`

const CHANGELOG = [
  '# Changelog',
  '## 2.1.311',
  '- Not yet on the channel',
  '## 2.1.310',
  '- Added resumable things',
  '## 2.1.305',
  '- Fixed a crash',
  '## 2.1.304',
  '- Already installed',
].join('\n')

const BAND = {
  plugin: 'cc-resumable-update',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'cc-resumable-update',
  component: 'Pane',
  requestId: 'cc-resumable-update',
  props: {
    title: 'Claude Code',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

type World = {
  files: Map<string, number>
  hashes: Map<string, string>
  toasts: string[]
  curls: number
  // Bytes each curl attempt leaves in the partial file, in order.
  curlEnds: number[]
  model: { system: string; prompt: string; model: string }[]
}

// Stands in for the engine and the machine: a native install of 2.1.304 on
// linux-arm64 with zstd, the stable channel at `channel`.
function world(on: any, channel: string, badHash = false, redownload = false): World {
  const w: World = {
    files: new Map([[`${DIR}/2.1.304`, RAW.size]]),
    hashes: new Map(),
    toasts: [],
    curls: 0,
    curlEnds: [ZST.size],
    model: [],
  }
  const mtimes = new Map<string, number>()
  mock.store(on)
  on('command.register', () => ({ value: { command: 'check-update' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.version', () => ({ value: { version: '2.1.304', base: '2.1.304' } }))
  on('ui.toast', (_: unknown, e: { text: string }) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('settings.read', () => ({ value: { language: 'Simplified Chinese' } }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('model.complete', (_: unknown, e: { system: string; prompt: string; model: string }) => {
    w.model.push(e)
    return {
      value: {
        isAnswered: true,
        text: '- 新功能：可续传\n- 修复：崩溃',
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }
  })
  on('http.fetch', (_: unknown, e: { url: string }) => {
    const ok = (text: string) => ({ value: { status: 200, ok: true, headers: {}, text } })
    if (e.url.endsWith('/stable')) return ok(`${channel}\n`)
    if (e.url.endsWith('/2.1.310/manifest.json')) return ok(JSON.stringify({ platforms: { [PLAT]: RAW } }))
    if (e.url.endsWith('/2.1.310/manifest.zst.json')) return ok(JSON.stringify({ platforms: { [PLAT]: ZST } }))
    if (e.url.endsWith('CHANGELOG.md')) return ok(CHANGELOG)
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: w.files.has(e.path) }))
  on('fs.stat', (_: unknown, e: { path: string }) =>
    w.files.has(e.path)
      ? { value: { kind: 'file', size: w.files.get(e.path), mtimeMs: mtimes.get(e.path) ?? 0, isLink: false } }
      : { deny: 'ENOENT' },
  )
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const [cmd, ...args] = e.argv
    const done = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (cmd === 'uname') return done('Linux aarch64\n')
    if (cmd === 'sh' && args[1].startsWith('printf')) return done(`${HOME}\n${HOME}/.local/share\nzstd\nsha256sum\n`)
    if (cmd === 'sha256sum') return done(`${badHash ? 'b'.repeat(64) : (w.hashes.get(args[0]) ?? '0'.repeat(64))}  ${args[0]}\n`)
    if (cmd === 'sh' && args[1].startsWith('zstd')) {
      w.files.set(args[4], RAW.size)
      w.hashes.set(args[4], RAW.checksum)
      return done()
    }
    if (cmd === 'sh' && args[1].startsWith('mv')) {
      w.files.set(args[4], w.files.get(args[3]) ?? 0)
      w.hashes.set(args[4], w.hashes.get(args[3]) ?? '')
      w.files.delete(args[3])
      return done()
    }
    if (cmd === 'rm') {
      for (const p of args.slice(1)) w.files.delete(p)
      return done()
    }
    return done()
  })
  on('process.spawn', async function* (_: unknown, e: { argv: readonly string[] }) {
    if (e.argv[0] === 'curl') {
      const end = w.curlEnds[w.curls++] ?? ZST.size
      w.files.set(ZTMP, end)
      if (end >= ZST.size) w.hashes.set(ZTMP, ZST.checksum)
      yield { stream: 'stderr' as const, text: '\r###### 50.0%' }
      return { value: { code: end >= ZST.size ? 0 : 18, signal: null } }
    }
    // An installer that downloads again replaces the binary, so its mtime moves.
    if (redownload) mtimes.set(OUT, 999)
    yield { stream: 'stdout' as const, text: 'Claude Code successfully installed!\n' }
    return { value: { code: 0, signal: null } }
  })
  return w
}

const start = async ($: any) => {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'check-update', args: '' })
}

test('a newer stable release shows the band, toasts once, and can be skipped', { options: { channel: 'stable' } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, '2.1.310')
  await start($)
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const line = await ui.find({ type: 'Text', text: /2\.1\.310 is available on stable/ })
    expect(line?.text).toContain('you have 2.1.304')
    expect(await ui.find({ type: 'Button', key: 'upgrade' })).toBeDefined()
    await ui.unmount()
  }
  expect(w.toasts).toEqual(['Claude Code 2.1.310 is out on stable'])

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'skip' })
  expect(await ui.find({ type: 'Text', text: /is available/ })).toBeUndefined()
  await ui.unmount()
})

test('upgrading downloads the zstd build with resume, verifies, unpacks and installs', { options: { channel: 'stable' } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, '2.1.310')
  // The first attempt drops after 40 MiB; the second resumes to the end.
  w.curlEnds = [40 * 1024 * 1024, ZST.size]
  await start($)
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'upgrade' })
  expect((await ui.find({ type: 'Text', text: /Install 2\.1\.310\?/ }))?.text).toContain('Downloads 100 MiB (zstd)')

  await ui.press({ key: 'confirm' })
  await clock.advance(10)
  await clock.advance(5000)
  await clock.settle()

  expect(w.curls).toBe(2)
  expect(w.files.get(OUT)).toBe(RAW.size)
  expect(w.files.has(ZTMP)).toBe(false)
  expect(w.files.has(UNPACKED)).toBe(false)
  expect(await ui.find({ type: 'Text', text: /✓ Installed 2\.1\.310/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /downloaded the binary again/ })).toBeUndefined()
  await ui.unmount()
})

test('a download that does not verify is removed and reported', { options: { channel: 'stable' } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, '2.1.310', true)
  await start($)
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'upgrade' })
  await ui.press({ key: 'confirm' })
  await clock.advance(10)
  await clock.settle()

  expect(w.files.has(ZTMP)).toBe(false)
  expect(w.files.has(OUT)).toBe(false)
  expect((await ui.find({ type: 'Text', text: /Upgrade stopped/ }))?.text).toContain('checksum mismatch')
  await ui.unmount()
})

test('the changelog between the two versions is summarized in the language setting', { options: { channel: 'stable' } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, '2.1.310')
  await start($)
  await clock.advance(10)
  await clock.settle()

  expect(w.model.length).toBe(1)
  expect(w.model[0].model).toBe('haiku')
  expect(w.model[0].system).toContain('Write in Simplified Chinese')
  expect(w.model[0].prompt).toContain('## 2.1.310')
  expect(w.model[0].prompt).toContain('## 2.1.305')
  expect(w.model[0].prompt).not.toContain('2.1.311')
  expect(w.model[0].prompt).not.toContain('## 2.1.304')

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Button', key: 'news' })).toBeDefined()
  await band.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /可续传/ }))?.text).toBe('- 新功能：可续传')
  await pane.unmount()

  // A second check of the same pair reads the stored summary.
  await $.command.run({ command: 'check-update', args: '' })
  await clock.advance(10)
  await clock.settle()
  expect(w.model.length).toBe(1)
})

test('the running version being the newest shows nothing', { options: { channel: 'stable' } }, async ($, on) => {
  const clock = mock.clock(on)
  world(on, '2.1.304')
  await start($)
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('on Windows the plain build downloads with curl.exe and moves into place through PowerShell', { options: { channel: 'stable' } }, async ($, on) => {
  const clock = mock.clock(on)
  const WHOME = 'C:\\Users\\u'
  const WDIR = `${WHOME}\\.local\\share\\claude\\versions`
  const WRAW = { binary: 'claude.exe', checksum: 'w'.repeat(64), size: 290 * 1024 * 1024 }
  const WTMP = `${WDIR}\\.2.1.310.win32-x64.partial`
  const files = new Map<string, number>([[`${WDIR}\\2.1.304`, WRAW.size], [`${WHOME}\\.local\\bin\\claude.exe`, 1]])
  const hashes = new Map<string, string>()
  const spawned: string[][] = []
  const ps: { script: string; env?: Record<string, string> }[] = []

  mock.store(on)
  on('command.register', () => ({ value: { command: 'check-update' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.version', () => ({ value: { version: '2.1.304', base: '2.1.304' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('http.fetch', (_: unknown, e: { url: string }) => {
    const ok = (text: string) => ({ value: { status: 200, ok: true, headers: {}, text } })
    if (e.url.endsWith('/stable')) return ok('2.1.310\n')
    if (e.url.endsWith('/2.1.310/manifest.json')) return ok(JSON.stringify({ platforms: { 'win32-x64': WRAW } }))
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
  // The kit runs on Unix and reads C:\ paths as relative to the working directory.
  const win = (p: string) => p.slice(Math.max(0, p.indexOf('C:\\')))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: files.has(win(e.path)) }))
  on('fs.stat', (_: unknown, e: { path: string }) =>
    files.has(win(e.path)) ? { value: { kind: 'file', size: files.get(win(e.path)), mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' },
  )
  on('process.run', (_: unknown, e: { argv: readonly string[]; init?: { env?: Record<string, string> } }) => {
    const done = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (e.argv[0] === 'uname') return { deny: 'ENOENT' }
    if (e.argv[0] !== 'powershell') return done()
    const script = e.argv[e.argv.length - 1]
    const env = e.init?.env
    ps.push({ script, env })
    if (script.startsWith('$env:USERPROFILE')) return done(`${WHOME}\r\n${WHOME}\\.local\\share\r\nAMD64 \r\n`)
    if (script.includes('Get-FileHash')) return done(`${(hashes.get(env!.CRU_A) ?? '0'.repeat(64)).toUpperCase()}\r\n`)
    if (script.startsWith('Move-Item')) {
      files.set(env!.CRU_B, files.get(env!.CRU_A) ?? 0)
      files.delete(env!.CRU_A)
    }
    return done()
  })
  on('process.spawn', async function* (_: unknown, e: { argv: readonly string[] }) {
    spawned.push([...e.argv])
    if (e.argv[0] === 'curl.exe') {
      files.set(WTMP, WRAW.size)
      hashes.set(WTMP, WRAW.checksum)
      yield { stream: 'stderr' as const, text: '\r###### 100.0%' }
      return { value: { code: 0, signal: null } }
    }
    yield { stream: 'stdout' as const, text: 'Claude Code successfully installed!\r\n' }
    return { value: { code: 0, signal: null } }
  })

  await start($)
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'upgrade' })
  expect((await ui.find({ type: 'Text', text: /Install 2\.1\.310\?/ }))?.text).toContain('Downloads 290 MiB, resumable')
  await ui.press({ key: 'confirm' })
  await clock.advance(10)
  await clock.settle()

  expect(spawned[0].slice(0, 4)).toEqual(['curl.exe', '-fL', '-C', '-'])
  expect(spawned[0][spawned[0].length - 1]).toBe('https://downloads.claude.ai/claude-code-releases/2.1.310/win32-x64/claude.exe')
  expect(spawned[1]).toEqual([`${WHOME}\\.local\\bin\\claude.exe`, 'install', '2.1.310'])
  expect(files.get(`${WDIR}\\2.1.310`)).toBe(WRAW.size)
  expect(ps.some(c => c.script.startsWith('Move-Item') && c.env?.CRU_A === WTMP)).toBe(true)
  expect(await ui.find({ type: 'Text', text: /✓ Installed 2\.1\.310/ })).toBeDefined()
  await ui.unmount()
})

test('an installer that downloads the binary again is reported', { options: { channel: 'stable' } }, async ($, on) => {
  const clock = mock.clock(on)
  world(on, '2.1.310', false, true)
  await start($)
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'upgrade' })
  await ui.press({ key: 'confirm' })
  await clock.advance(10)
  await clock.settle()

  expect(await ui.find({ type: 'Text', text: /✓ Installed 2\.1\.310/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /downloaded the binary again/ }))?.text).toContain('saved nothing')
  await ui.unmount()
})
