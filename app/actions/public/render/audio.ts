// Opt-in sonar ping (PLAN §5): 1200 Hz sine, ~300 ms decay, higher and louder for closer
// contacts, at most MAX_PER_SWEEP pings per sweep. Muted by default; enable() must run inside a
// user gesture so the browser lets the AudioContext start.

export const MAX_PER_SWEEP = 6
const BASE_HZ = 1200

export type Pinger = {
  enable(): void
  disable(): void
  /** Call when the beam wraps past 0 ID°. */
  newSweep(): void
  /** `closeness` 0 (far) .. 1 (touching). Returns false when muted or over budget. */
  ping(closeness: number): boolean
  destroy(): void
}

/** Pure parameters for one ping, exported for tests. */
export function pingParams(closeness: number): { freq: number; gain: number; decay: number } {
  let c = Math.max(0, Math.min(1, closeness))
  return { freq: BASE_HZ * (1 + 0.35 * c), gain: 0.03 + 0.12 * c, decay: 0.3 }
}

export function createPinger(): Pinger {
  let ctx: AudioContext | undefined
  let master: GainNode | undefined
  let enabled = false
  let budget = MAX_PER_SWEEP

  return {
    enable() {
      enabled = true
      if (!ctx) {
        let Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!Ctor) return
        ctx = new Ctor()
        master = ctx.createGain()
        master.gain.value = 0.8
        master.connect(ctx.destination)
      }
      void ctx.resume()
    },
    disable() {
      enabled = false
      void ctx?.suspend()
    },
    newSweep() {
      budget = MAX_PER_SWEEP
    },
    ping(closeness) {
      if (!enabled || !ctx || !master || ctx.state !== 'running' || budget <= 0) return false
      budget--
      let { freq, gain, decay } = pingParams(closeness)
      let t = ctx.currentTime
      let osc = ctx.createOscillator()
      let env = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, t)
      // A slight downward chirp reads as "sonar" rather than "beep".
      osc.frequency.exponentialRampToValueAtTime(freq * 0.94, t + decay)
      env.gain.setValueAtTime(0.0001, t)
      env.gain.exponentialRampToValueAtTime(gain, t + 0.006)
      env.gain.exponentialRampToValueAtTime(0.0001, t + decay)
      osc.connect(env).connect(master)
      osc.start(t)
      osc.stop(t + decay + 0.02)
      osc.onended = () => env.disconnect()
      return true
    },
    destroy() {
      enabled = false
      void ctx?.close()
      ctx = undefined
    },
  }
}
