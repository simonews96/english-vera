import { describe, expect, it } from "vitest";
import {
  EXCLUDED_NAME_PARTS,
  isExcludedVoice,
  nameHasPart,
  normalizeLang,
  resolveVoice,
  VOICE_PREFERENCES,
} from "../../src/voice/voices";
import { makeVoiceInfo } from "../helpers/voice-synthesis-fake";

const v = makeVoiceInfo;

describe("normalizeLang", () => {
  it("converts Android underscores and normalises case", () => {
    expect(normalizeLang("en_GB")).toBe("en-GB");
    expect(normalizeLang("EN-gb")).toBe("en-GB");
    expect(normalizeLang("it_IT")).toBe("it-IT");
    expect(normalizeLang("en")).toBe("en");
    expect(normalizeLang("zh-hans-cn")).toBe("zh-Hans-CN");
    expect(normalizeLang("")).toBe("");
  });
});

describe("name matching", () => {
  it("matches whole tokens for single words and substrings for phrases", () => {
    expect(nameHasPart("Anna", "Ana")).toBe(false);
    expect(nameHasPart("Ana (Enhanced)", "Ana")).toBe(true);
    expect(nameHasPart("Flora", "Flo")).toBe(false);
    expect(nameHasPart("Microsoft Mark - English (United States)", "Microsoft Mark")).toBe(true);
    expect(
      nameHasPart(
        "microsoft sonia online (natural) - english (united kingdom)",
        "Microsoft Sonia Online (Natural)",
      ),
    ).toBe(true);
  });

  it("excludes child, Eloquence and novelty voices", () => {
    expect(EXCLUDED_NAME_PARTS).toContain("Maisie");
    expect(isExcludedVoice(v({ name: "Eddy (English (UK))", lang: "en-GB" }))).toBe(true);
    expect(
      isExcludedVoice(
        v({ name: "Microsoft Maisie Online (Natural) - English (United Kingdom)", lang: "en-GB" }),
      ),
    ).toBe(true);
    expect(isExcludedVoice(v({ name: "Bad News", lang: "en-US" }))).toBe(true);
    expect(isExcludedVoice(v({ name: "Samantha", lang: "en-US" }))).toBe(false);
  });
});

describe("resolveVoice", () => {
  const edgeVoices = [
    v({ name: "Microsoft Ryan Online (Natural) - English (United Kingdom)", lang: "en-GB" }),
    v({ name: "Microsoft Maisie Online (Natural) - English (United Kingdom)", lang: "en-GB" }),
    v({ name: "Microsoft Sonia Online (Natural) - English (United Kingdom)", lang: "en-GB" }),
    v({ name: "Microsoft AvaMultilingual Online (Natural) - English (United States)", lang: "en-US" }),
    v({ name: "Microsoft Giuseppe Online (Natural) - Italian (Italy)", lang: "it-IT" }),
    v({ name: "Microsoft Elsa Online (Natural) - Italian (Italy)", lang: "it-IT" }),
    v({ name: "Microsoft Hazel - English (Great Britain)", lang: "en-GB" }),
  ];

  it("prefers the ranked list for the requested variant (step 1)", () => {
    const en = resolveVoice(edgeVoices, "en", "en-GB");
    expect(en.step).toBe(1);
    expect(en.voice?.name).toContain("Sonia");
    const us = resolveVoice(edgeVoices, "en", "en-US");
    expect(us.voice?.name).toContain("AvaMultilingual");
    const it = resolveVoice(edgeVoices, "it", "en-GB");
    expect(it.step).toBe(1);
    expect(it.voice?.name).toContain("Elsa");
  });

  it("falls back to the other English variant before leaving the preference list", () => {
    const voices = [
      v({ name: "Google US English", lang: "en-US" }),
      v({ name: "Google UK English Male", lang: "en-GB" }),
    ];
    const res = resolveVoice(voices, "en", "en-GB");
    expect(res.step).toBe(1);
    expect(res.voice?.name).toBe("Google US English");
  });

  it("honours a saved voice id as step 0 and ignores unknown ids", () => {
    const saved = resolveVoice(edgeVoices, "en", "en-GB", "Microsoft Hazel - English (Great Britain)");
    expect(saved.step).toBe(0);
    expect(saved.voice?.name).toContain("Hazel");
    const unknown = resolveVoice(edgeVoices, "en", "en-GB", "gone");
    expect(unknown.step).toBe(1);
  });

  it("works on Android, where names are locale display names and langs use underscores", () => {
    const android = [
      v({ name: "English United States", lang: "en_US" }),
      v({ name: "Inglese Regno Unito", lang: "en_GB" }),
      v({ name: "Italiano Italia", lang: "it_IT" }),
    ];
    const en = resolveVoice(android, "en", "en-GB");
    expect(en.step).toBe(2);
    expect(en.voice?.lang).toBe("en_GB");
    const us = resolveVoice(android, "en", "en-US");
    expect(us.voice?.lang).toBe("en_US");
    const it = resolveVoice(android, "it", "en-GB");
    expect(it.step).toBe(2);
    expect(it.voice?.lang).toBe("it_IT");
  });

  it("recognises Edge 150 broken names from the voiceURI", () => {
    const edge150 = [
      v({
        name: "Microsoft undefined Online (Natural) - undefined",
        voiceURI: "Microsoft Ryan Online (Natural) - English (United Kingdom)",
        lang: "en-GB",
      }),
      v({
        name: "Microsoft undefined Online (Natural) - undefined",
        voiceURI: "Microsoft Sonia Online (Natural) - English (United Kingdom)",
        lang: "en-GB",
      }),
    ];
    const res = resolveVoice(edge150, "en", "en-GB");
    expect(res.step).toBe(1);
    expect(res.voice?.id).toContain("Sonia");
  });

  it("uses lang for Natural voices whose name and id are both broken", () => {
    const edge150 = [
      v({
        name: "Microsoft undefined Online (Natural) - undefined",
        voiceURI: "urn:natural:1",
        lang: "en-US",
      }),
      v({
        name: "Microsoft undefined Online (Natural) - undefined",
        voiceURI: "urn:natural:2",
        lang: "en-GB",
      }),
    ];
    const res = resolveVoice(edge150, "en", "en-GB");
    expect(res.step).toBe(1);
    expect(res.voice?.lang).toBe("en-GB");
    expect(res.reason).toContain("broken name");
  });

  it("skips obviously male voices in step 2", () => {
    const voices = [v({ name: "Daniel", lang: "en-GB" }), v({ name: "Moira", lang: "en-IE" })];
    const res = resolveVoice(voices, "en", "en-GB");
    expect(res.step).toBe(2);
    expect(res.voice?.name).toBe("Moira");
  });

  it("falls back to Eloquence voices on iOS 18 (step 3) rather than leaving the language without a voice", () => {
    const ios = [
      v({ name: "Eddy (English (UK))", lang: "en-GB" }),
      v({ name: "Flo (English (UK))", lang: "en-GB" }),
      v({ name: "Daniel", lang: "en-GB" }),
      v({ name: "Alice", lang: "it-IT" }),
    ];
    const en = resolveVoice(ios, "en", "en-GB");
    expect(en.step).toBe(3);
    expect(en.voice?.name).toBe("Eddy (English (UK))");
    const it = resolveVoice(ios, "it", "en-GB");
    expect(it.step).toBe(1);
    expect(it.voice?.name).toBe("Alice");
  });

  it("prefers Samantha over Daniel on an iOS list without an en-GB female", () => {
    const ios = [
      v({ name: "Daniel", lang: "en-GB" }),
      v({ name: "Samantha", lang: "en-US" }),
      v({ name: "Karen", lang: "en-AU" }),
    ];
    const res = resolveVoice(ios, "en", "en-GB");
    expect(res.step).toBe(1);
    expect(res.voice?.name).toBe("Samantha");
  });

  it("returns step 4 with a null voice when the language has no voice at all", () => {
    const res = resolveVoice([v({ name: "Alice", lang: "it-IT" })], "en", "en-GB");
    expect(res).toEqual({ voice: null, step: 4, reason: expect.stringContaining("step 4") });
  });

  it("does not let the Italian 'Emma' preference pick the English EmmaMultilingual voice", () => {
    const voices = [
      v({ name: "Microsoft EmmaMultilingual Online (Natural) - English (United States)", lang: "en-US" }),
      v({ name: "Google italiano", lang: "it-IT" }),
    ];
    const res = resolveVoice(voices, "it", "en-GB");
    expect(res.voice?.name).toBe("Google italiano");
    expect(VOICE_PREFERENCES["it-IT"]).toContain("Emma");
  });
});
