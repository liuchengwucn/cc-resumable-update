export type Notice = { target: string; current: string; isNative: boolean }

export type Upgrade =
  // Upgrade was pressed; the download size is being worked out.
  | { phase: 'preparing'; version: string }
  | { phase: 'confirm'; version: string; downloadMiB: number | null; isCompressed: boolean }
  | {
      phase: 'running'
      version: string
      stage: 'prepare' | 'download' | 'verify' | 'unpack' | 'install'
      doneMiB: number
      totalMiB: number
      line: string
      isCancelling: boolean
    }
  // isRedownloaded: claude install replaced the binary this mod placed, so the
  // resumable download saved nothing this time.
  | { phase: 'done'; version: string; isRedownloaded: boolean }
  | { phase: 'failed'; version: string; line: string }

export type Summary = {
  from: string
  to: string
  status: 'pending' | 'ready' | 'failed'
  text: string
}

declare module 'claude-code' {
  interface PluginState {
    'cc-resumable-update': {
      notice: Notice | null
      upgrade: Upgrade | null
      summary: Summary | null
    }
  }
}
