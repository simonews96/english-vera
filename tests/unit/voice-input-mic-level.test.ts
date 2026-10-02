import { describe, expect, it } from "vitest";
import {
  CALIBRATION_MS,
  createEnvelope,
  createMicLevel,
  dbfs,
  normalizeLevel,
} from "../../src/voice/mic-level";

describe("createEnvelope", () => {
  it("rises with the attack time constant and falls with the slower release", () => {
    const envelope = createEnvelope({ attackMs: 40, releaseMs: 250 });
    const afterAttack = envelope.update(1, 40);
    expect(afterAttack).toBeCloseTo(1 - Math.exp(-1), 5);
    const peak = envelope.update(1, 1000);
    expect(peak).toBeGreaterThan(0.99);
    const afterRelease = envelope.update(0, 40);
    // After 40 ms of release the level has lost far less than it gained in 40 ms of attack.
    expect(peak - afterRelease).toBeLessThan(afterAttack / 2);
    expect(afterRelease).toBeCloseTo(peak * Math.exp(-40 / 250), 5);
  });

  it("is pure in the sense of returning the smoothed value and ignoring bad input", () => {
    const envelope = createEnvelope();
    expect(envelope.update(Number.NaN, 16)).toBe(0);
    expect(envelope.update(0.5, 0)).toBe(0);
    expect(createEnvelope({ attackMs: 0 }).update(0.7, 1)).toBeCloseTo(0.7, 9);
  });
});

describe("dbfs and normalizeLevel", () => {
  it("converts RMS to dB and floors silence", () => {
    expect(dbfs(1)).toBe(0);
    expect(dbfs(0.1)).toBeCloseTo(-20, 9);
    expect(dbfs(0)).toBe(-100);
    expect(dbfs(-1)).toBe(-100);
    expect(dbfs(1e-9)).toBe(-100);
  });

  it("maps floor+6 .. floor+40 dB to 0..1", () => {
    expect(normalizeLevel(-60, -60)).toBe(0);
    expect(normalizeLevel(-54, -60)).toBe(0);
    expect(normalizeLevel(-37, -60)).toBeCloseTo(0.5, 9);
    expect(normalizeLevel(-20, -60)).toBe(1);
    expect(normalizeLevel(0, -60)).toBe(1);
  });
});

interface FakeAudio {
  amplitude: number;
  frames: Array<() => void>;
  closed: boolean;
  stoppedTracks: number;
}

function fakeAudio(): FakeAudio & {
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>;
  ctor: typeof AudioContext;
  requestFrame: (cb: () => void) => void;
} {
  const state: FakeAudio = { amplitude: 0, frames: [], closed: false, stoppedTracks: 0 };
  const stream = {
    getTracks: () => [
      {
        stop: () => {
          state.stoppedTracks += 1;
        },
      },
    ],
  } as unknown as MediaStream;
  class FakeContext {
    state = "running";
    createAnalyser() {
      return {
        fftSize: 2048,
        getFloatTimeDomainData: (buffer: Float32Array) => {
          buffer.fill(state.amplitude);
        },
      };
    }
    createMediaStreamSource() {
      return { connect: () => undefined, disconnect: () => undefined };
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      state.closed = true;
      return Promise.resolve();
    }
  }
  return {
    ...state,
    get amplitude() {
      return state.amplitude;
    },
    set amplitude(value: number) {
      state.amplitude = value;
    },
    get frames() {
      return state.frames;
    },
    get closed() {
      return state.closed;
    },
    get stoppedTracks() {
      return state.stoppedTracks;
    },
    getUserMedia: () => Promise.resolve(stream),
    ctor: FakeContext as unknown as typeof AudioContext,
    requestFrame: (cb) => {
      state.frames.push(cb);
    },
  };
}

describe("createMicLevel", () => {
  it("fails soft with an Italian message when the APIs are missing", async () => {
    const mic = createMicLevel({ getUserMedia: undefined, audioContextCtor: undefined });
    await expect(mic.start()).rejects.toThrow("Microfono non disponibile");
    const denied = createMicLevel({
      getUserMedia: () => Promise.reject(new Error("NotAllowedError")),
      audioContextCtor: fakeAudio().ctor,
    });
    await expect(denied.start()).rejects.toThrow("Microfono non disponibile");
    expect(mic.level).toBe(0);
  });

  it("calibrates the noise floor, then normalizes and smooths the level", async () => {
    const audio = fakeAudio();
    let clock = 0;
    const mic = createMicLevel({
      getUserMedia: audio.getUserMedia,
      audioContextCtor: audio.ctor,
      requestFrame: audio.requestFrame,
      now: () => clock,
    });
    const seen: number[] = [];
    mic.subscribe((level) => seen.push(level));
    audio.amplitude = 0.001; // -60 dBFS room tone
    await mic.start();
    const runFrame = (dtMs: number) => {
      clock += dtMs;
      const frame = audio.frames.shift();
      if (!frame) throw new Error("no frame scheduled");
      frame();
    };
    while (clock < CALIBRATION_MS) runFrame(100);
    expect(mic.calibrated).toBe(true);
    expect(mic.noiseFloorDb).toBeCloseTo(-60, 5);
    expect(mic.level).toBe(0);

    audio.amplitude = 0.1; // -20 dBFS = floor + 40 dB -> target 1
    for (let i = 0; i < 20; i += 1) runFrame(16);
    expect(mic.level).toBeGreaterThan(0.95);
    audio.amplitude = 0.001;
    runFrame(16);
    expect(mic.level).toBeGreaterThan(0.8); // release is slow
    for (let i = 0; i < 100; i += 1) runFrame(16);
    expect(mic.level).toBeLessThan(0.01);
    expect(seen.length).toBeGreaterThan(0);

    mic.stop();
    expect(mic.level).toBe(0);
    expect(audio.closed).toBe(true);
    expect(audio.stoppedTracks).toBe(1);
    const pending = audio.frames.length;
    for (const frame of audio.frames.splice(0)) frame();
    expect(audio.frames).toHaveLength(0);
    expect(pending).toBeGreaterThanOrEqual(0);
  });
});
