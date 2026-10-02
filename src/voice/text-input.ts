/**
 * SpeechInput for text-only mode: the user types instead of speaking. Same event contract
 * as the voice engines, so the session machine does not care which one is behind it.
 */

import type { SpeechInput, SpeechInputCapabilities, SpeechInputEvent } from "./types";

export interface TextInput extends SpeechInput {
  /** Delivers typed text as a `final` result followed by `end` (cause "text"). Blank text is ignored. */
  submit(text: string): void;
}

const CAPABILITIES: SpeechInputCapabilities = {
  available: true,
  continuous: true,
  interimResults: false,
  onDevice: true,
  profile: "text",
};

export function createTextInput(): TextInput {
  const listeners = new Set<(event: SpeechInputEvent) => void>();
  let listening = false;

  function emit(event: SpeechInputEvent): void {
    for (const listener of [...listeners]) listener(event);
  }

  function end(cause: string): void {
    if (!listening) return;
    listening = false;
    emit({ type: "end", cause });
  }

  return {
    capabilities: CAPABILITIES,
    start() {
      end("own-abort");
      listening = true;
      emit({ type: "start" });
      return Promise.resolve();
    },
    stop() {
      end("stop");
    },
    abort() {
      end("own-abort");
    },
    submit(text) {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      listening = true;
      emit({ type: "final", text: trimmed, confidence: 1 });
      end("text");
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
