/**
 * Platform detection used to pick voice profiles and to fill the diagnostics label.
 * Feature presence is NOT feature function: on iOS the SpeechRecognition constructor exists
 * even where it cannot work, so engines also probe at runtime.
 */

export type Os = "windows" | "macos" | "ios" | "android" | "linux" | "chromeos" | "unknown";
export type Browser = "chrome" | "edge" | "safari" | "firefox" | "samsung" | "unknown";

export interface PlatformInfo {
  readonly os: Os;
  readonly browser: Browser;
  /** Installed to the home screen / running as a PWA window. */
  readonly standalone: boolean;
  readonly touch: boolean;
  readonly hasSpeechRecognition: boolean;
  readonly hasSpeechSynthesis: boolean;
  readonly hasGetUserMedia: boolean;
  readonly hasWakeLock: boolean;
  readonly hasVibrate: boolean;
  readonly hasMediaSession: boolean;
  readonly prefersReducedMotion: boolean;
  readonly prefersDark: boolean;
  readonly userAgent: string;
}

export function detectPlatform(win: Window & typeof globalThis = window): PlatformInfo {
  const nav = win.navigator;
  const ua = nav.userAgent;
  const isIpadOs = /Macintosh/.test(ua) && nav.maxTouchPoints > 1;
  let os: Os = "unknown";
  if (/Windows/.test(ua)) os = "windows";
  else if (/Android/.test(ua)) os = "android";
  else if (/iPhone|iPad|iPod/.test(ua) || isIpadOs) os = "ios";
  else if (/CrOS/.test(ua)) os = "chromeos";
  else if (/Macintosh|Mac OS X/.test(ua)) os = "macos";
  else if (/Linux/.test(ua)) os = "linux";

  let browser: Browser = "unknown";
  if (/Edg\//.test(ua)) browser = "edge";
  else if (/SamsungBrowser/.test(ua)) browser = "samsung";
  else if (/CriOS|EdgiOS|FxiOS/.test(ua)) browser = os === "ios" ? "safari" : "unknown";
  else if (/Chrome\//.test(ua)) browser = "chrome";
  else if (/Firefox\//.test(ua)) browser = "firefox";
  else if (/Safari\//.test(ua)) browser = "safari";

  const standalone =
    (win.matchMedia?.("(display-mode: standalone)").matches ?? false) ||
    (nav as Navigator & { standalone?: boolean }).standalone === true;

  const w = win as Window & { webkitSpeechRecognition?: unknown; SpeechRecognition?: unknown };
  return {
    os,
    browser,
    standalone,
    touch: nav.maxTouchPoints > 0,
    hasSpeechRecognition:
      typeof w.SpeechRecognition === "function" || typeof w.webkitSpeechRecognition === "function",
    hasSpeechSynthesis: "speechSynthesis" in win && typeof win.SpeechSynthesisUtterance === "function",
    hasGetUserMedia: typeof nav.mediaDevices?.getUserMedia === "function",
    hasWakeLock: "wakeLock" in nav,
    hasVibrate: typeof nav.vibrate === "function",
    hasMediaSession: "mediaSession" in nav,
    prefersReducedMotion: win.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
    prefersDark: win.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
    userAgent: ua,
  };
}

/** True when the recognizer should use one-phrase sessions (phones) instead of continuous mode. */
export function usesUtteranceProfile(platform: PlatformInfo): boolean {
  return platform.os === "android" || platform.os === "ios";
}
