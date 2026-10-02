/**
 * Copies text to the clipboard: the async API when present and allowed, otherwise a hidden
 * textarea with `execCommand("copy")` (older Safari, non-secure contexts). Resolves to whether
 * the text ended up on the clipboard.
 */

function legacyCopy(text: string): boolean {
  const doc = globalThis.document;
  if (!doc?.body) return false;
  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  doc.body.append(area);
  try {
    area.focus();
    area.select();
    const exec = (doc as Document & { execCommand?: (command: string) => boolean }).execCommand;
    return typeof exec === "function" ? exec.call(doc, "copy") : false;
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

export async function copyText(text: string): Promise<boolean> {
  const clipboard = (globalThis as { navigator?: Partial<Navigator> }).navigator?.clipboard;
  if (clipboard && typeof clipboard.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or not in a user gesture: fall through to the textarea.
    }
  }
  return legacyCopy(text);
}

/** Time the "Copiato" confirmation stays on the word. */
export const COPIED_FEEDBACK_MS = 1500;
