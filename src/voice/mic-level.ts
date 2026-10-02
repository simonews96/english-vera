/**
 * Microphone level for the "Vera reacts to your voice" animation (desktop only by default).
 *
 * Pipeline: getUserMedia -> AnalyserNode (fftSize 1024) -> RMS -> dBFS -> noise floor
 * calibrated on the first 600 ms -> normalized 0..1 between floor+6 dB and floor+40 dB ->
 * attack/release envelope.
 *
 * Platform rule (docs/PIANO.md §1.2, verified): on Android never open this stream while the
 * native recognizer is active: two captures conflict and the phone drops into "call" mode.
 * This module does not check the platform; the caller decides (on Android, drive the
 * animation from interim/final results instead). On iOS, if ever enabled, keep
 * `echoCancellation: true` and create the AudioContext after the stream.
 */

export const DEFAULT_ATTACK_MS = 40;
export const DEFAULT_RELEASE_MS = 250;
export const CALIBRATION_MS = 600;
export const FFT_SIZE = 1024;
/** Levels below floor + this many dB map to 0. */
export const FLOOR_MARGIN_DB = 6;
/** Levels at floor + this many dB (or louder) map to 1. */
export const FULL_SCALE_DB = 40;
const MIN_DB = -100;

export interface EnvelopeOptions {
  readonly attackMs?: number;
  readonly releaseMs?: number;
}

export interface Envelope {
  /** Feeds one sample; rising edges follow the attack time constant, falling edges the release. */
  update(value: number, dtMs: number): number;
  readonly value: number;
  reset(): void;
}

/** One-pole smoother with separate attack and release time constants. */
export function createEnvelope(options: EnvelopeOptions = {}): Envelope {
  const attackMs = Math.max(0, options.attackMs ?? DEFAULT_ATTACK_MS);
  const releaseMs = Math.max(0, options.releaseMs ?? DEFAULT_RELEASE_MS);
  let current = 0;
  return {
    get value() {
      return current;
    },
    update(value, dtMs) {
      const target = Number.isFinite(value) ? value : 0;
      const tau = target > current ? attackMs : releaseMs;
      const dt = Math.max(0, dtMs);
      const coefficient = tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
      current += (target - current) * coefficient;
      return current;
    },
    reset() {
      current = 0;
    },
  };
}

/** RMS (0..1) to decibels full scale, floored at -100 dB so silence stays finite. */
export function dbfs(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return MIN_DB;
  return Math.max(MIN_DB, 20 * Math.log10(rms));
}

function computeRms(samples: ArrayLike<number>): number {
  const count = samples.length;
  if (count === 0) return 0;
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const sample = samples[i] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / count);
}

/** Maps a level in dB to 0..1 between `floorDb + 6` and `floorDb + 40`. */
export function normalizeLevel(db: number, floorDb: number): number {
  const low = floorDb + FLOOR_MARGIN_DB;
  const high = floorDb + FULL_SCALE_DB;
  if (db <= low) return 0;
  if (db >= high) return 1;
  return (db - low) / (high - low);
}

export interface MicLevelOptions {
  readonly getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  readonly audioContextCtor?: typeof AudioContext;
  /** Frame scheduler; defaults to requestAnimationFrame (or a 16 ms timeout). */
  readonly requestFrame?: (callback: () => void) => void;
  readonly now?: () => number;
  readonly constraints?: MediaStreamConstraints;
  readonly attackMs?: number;
  readonly releaseMs?: number;
}

export interface MicLevel {
  /** Opens the microphone and starts measuring. Rejects with an Italian message when unavailable. */
  start(): Promise<void>;
  stop(): void;
  /** 0..1 after calibration; 0 while calibrating or stopped. */
  readonly level: number;
  /** Calibrated noise floor in dBFS; -100 until calibration completes. */
  readonly noiseFloorDb: number;
  readonly calibrated: boolean;
  subscribe(listener: (level: number) => void): () => void;
}

interface Capture {
  readonly stream: MediaStream;
  readonly context: AudioContext;
  readonly analyser: AnalyserNode;
  readonly source: MediaStreamAudioSourceNode;
}

function defaultGetUserMedia(): ((constraints: MediaStreamConstraints) => Promise<MediaStream>) | undefined {
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  const devices = nav?.mediaDevices;
  if (!devices || typeof devices.getUserMedia !== "function") return undefined;
  return (constraints) => devices.getUserMedia(constraints);
}

function defaultAudioContextCtor(): typeof AudioContext | undefined {
  const g = globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return g.AudioContext ?? g.webkitAudioContext;
}

function defaultRequestFrame(callback: () => void): void {
  const g = globalThis as { requestAnimationFrame?: (cb: () => void) => unknown };
  if (typeof g.requestAnimationFrame === "function") g.requestAnimationFrame(callback);
  else globalThis.setTimeout(callback, 16);
}

export function createMicLevel(options: MicLevelOptions = {}): MicLevel {
  const requestFrame = options.requestFrame ?? defaultRequestFrame;
  const now = options.now ?? (() => Date.now());
  const envelope = createEnvelope({ attackMs: options.attackMs, releaseMs: options.releaseMs });
  const listeners = new Set<(level: number) => void>();
  let capture: Capture | null = null;
  let generation = 0;
  let level = 0;
  let noiseFloorDb = MIN_DB;
  let calibrated = false;
  let calibrationStart = 0;
  let calibrationSum = 0;
  let calibrationCount = 0;
  let lastFrameAt = 0;

  function publish(next: number): void {
    if (next === level) return;
    level = next;
    for (const listener of [...listeners]) listener(level);
  }

  function frame(myGeneration: number, buffer: Float32Array<ArrayBuffer>): void {
    if (myGeneration !== generation || !capture) return;
    const at = now();
    const dt = lastFrameAt === 0 ? 0 : at - lastFrameAt;
    lastFrameAt = at;
    capture.analyser.getFloatTimeDomainData(buffer);
    const db = dbfs(computeRms(buffer));
    if (!calibrated) {
      calibrationSum += db;
      calibrationCount += 1;
      if (at - calibrationStart >= CALIBRATION_MS) {
        noiseFloorDb = calibrationSum / calibrationCount;
        calibrated = true;
      }
      publish(0);
    } else {
      publish(envelope.update(normalizeLevel(db, noiseFloorDb), dt));
    }
    requestFrame(() => frame(myGeneration, buffer));
  }

  async function start(): Promise<void> {
    if (capture) return;
    const getUserMedia = options.getUserMedia ?? defaultGetUserMedia();
    const Ctor = options.audioContextCtor ?? defaultAudioContextCtor();
    if (!getUserMedia || !Ctor) throw new Error("Microfono non disponibile");
    generation += 1;
    const myGeneration = generation;
    let stream: MediaStream;
    try {
      stream = await getUserMedia(options.constraints ?? { audio: true });
    } catch (cause) {
      throw new Error("Microfono non disponibile", { cause });
    }
    if (myGeneration !== generation) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    let context: AudioContext;
    try {
      context = new Ctor();
    } catch (cause) {
      for (const track of stream.getTracks()) track.stop();
      throw new Error("Audio non disponibile", { cause });
    }
    const analyser = context.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    capture = { stream, context, analyser, source };
    if (context.state === "suspended") {
      try {
        await context.resume();
      } catch {
        // A suspended context still measures once the page gets a gesture.
      }
    }
    if (myGeneration !== generation) return;
    calibrated = false;
    calibrationStart = now();
    calibrationSum = 0;
    calibrationCount = 0;
    lastFrameAt = 0;
    envelope.reset();
    requestFrame(() => frame(myGeneration, new Float32Array(analyser.fftSize)));
  }

  function stop(): void {
    generation += 1;
    const current = capture;
    capture = null;
    if (current) {
      try {
        current.source.disconnect();
      } catch {
        // Already disconnected.
      }
      for (const track of current.stream.getTracks()) track.stop();
      void current.context.close().catch(() => undefined);
    }
    envelope.reset();
    publish(0);
  }

  return {
    start,
    stop,
    get level() {
      return level;
    },
    get noiseFloorDb() {
      return noiseFloorDb;
    },
    get calibrated() {
      return calibrated;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
