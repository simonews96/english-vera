/**
 * Theme and motion live in the settings and on the root element: tokens.css derives the
 * palette from `data-theme` and the durations from `data-motion`. "system" removes the
 * attribute so the media queries decide.
 */

import type { MotionSetting, ThemeSetting } from "../../storage/settings";

export function applyAppearance(
  appearance: { readonly theme: ThemeSetting; readonly motion: MotionSetting },
  root: HTMLElement | undefined = globalThis.document?.documentElement,
): void {
  if (!root) return;
  if (appearance.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = appearance.theme;
  if (appearance.motion === "system") delete root.dataset.motion;
  else root.dataset.motion = appearance.motion;
}
