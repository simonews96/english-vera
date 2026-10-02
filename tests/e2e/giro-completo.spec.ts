import { mkdir } from "node:fs/promises";
import { expect, type Page, type Route, test } from "@playwright/test";
import type { TurnResponse } from "../../src/core/turn/schema";
import { anthropicSseBody } from "../helpers/llm-sse";
import { installFakeSpeech } from "./support/fake-speech";

const SHOTS = "tests/e2e/screenshots";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

const GREETING: TurnResponse = {
  segments: [
    { lang: "IT", kind: "SAY", text: "Ciao, sono Vera. Oggi impariamo a salutare." },
    { lang: "EN", kind: "MODEL", text: "Hello, I'm Simone." },
  ],
  listen: { lang: "EN", expect: "REPEAT", target: "Hello, I'm Simone." },
  correction: null,
  items: [],
  learned: [],
  about_learner: [],
  goal: { id: "g_a0_greet", status: "ONGOING" },
  closing: null,
};

/** The learner said "I have thirty years": reformulation to repeat, nothing learned yet. */
const CORRECTION: TurnResponse = {
  segments: [
    { lang: "IT", kind: "SAY", text: "Quasi. In inglese l'età si dice con to be." },
    { lang: "EN", kind: "MODEL", text: "I am thirty years old." },
  ],
  listen: { lang: "EN", expect: "REPEAT", target: "I am thirty years old." },
  correction: {
    heard: "I have thirty years",
    correct: "I am thirty years old",
    note_it: "L'età in inglese si dice con to be.",
  },
  items: [],
  learned: [],
  about_learner: [],
  goal: { id: "g_a0_greet", status: "ONGOING" },
  closing: null,
};

/** The learner repeated it right: now it is a row of the cloth. */
const CONFIRM: TurnResponse = {
  segments: [
    { lang: "EN", kind: "SAY", text: "Yes, that's it." },
    { lang: "IT", kind: "SAY", text: "Perfetto. Ora dimmi qualcos'altro di te." },
  ],
  listen: { lang: "EN", expect: "FREE" },
  correction: null,
  items: [],
  learned: [{ text_en: "I am thirty years old.", gloss_it: "Ho trent'anni.", topic: "SMALL_TALK" }],
  about_learner: [],
  goal: { id: "g_a0_greet", status: "ONGOING" },
  closing: null,
};

/** Five rows at once, to make the cloth long. */
function manyRows(turn: number): TurnResponse {
  return {
    segments: [{ lang: "EN", kind: "SAY", text: `Good, five more lines, round ${turn}.` }],
    listen: { lang: "EN", expect: "FREE" },
    correction: null,
    items: [],
    learned: Array.from({ length: 5 }, (_, i) => ({
      text_en: `Row ${turn * 5 + i + 1}: a sentence you can say now.`,
      gloss_it: "Una frase che sai dire.",
      topic: "SMALL_TALK" as const,
    })),
    about_learner: [],
    goal: { id: "g_a0_greet", status: "ONGOING" },
    closing: null,
  };
}

interface Captured {
  readonly bodies: Array<Record<string, unknown>>;
}

interface MockOptions {
  /** Status and headers of a failure returned to the first POST (the second succeeds). */
  readonly failFirst?: {
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly body: string;
  };
}

function lastUserText(body: Record<string, unknown>): string {
  const messages = body.messages as Array<{ content: string | Array<{ text: string }> }>;
  const content = messages[messages.length - 1]?.content ?? "";
  return typeof content === "string" ? content : content.map((block) => block.text).join(" ");
}

function pickReply(body: Record<string, unknown>, moreRounds: { count: number }): TurnResponse {
  const last = lastUserText(body);
  if (/\bmore\b/i.test(last)) return manyRows(moreRounds.count++);
  if (/I am thirty years old/i.test(last)) return CONFIRM;
  if (/thirty/i.test(last)) return CORRECTION;
  return GREETING;
}

async function mockClaude(page: Page, options: MockOptions = {}): Promise<Captured> {
  const captured: Captured = { bodies: [] };
  const moreRounds = { count: 0 };
  let posts = 0;
  await page.route(MESSAGES_URL, async (route: Route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 200,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-expose-headers": "*",
          "access-control-allow-methods": "POST, OPTIONS",
        },
      });
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    captured.bodies.push(body);
    posts += 1;
    if (posts === 1 && options.failFirst) {
      await route.fulfill({
        status: options.failFirst.status,
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "*",
          ...options.failFirst.headers,
        },
        body: options.failFirst.body,
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
      body: anthropicSseBody(pickReply(body, moreRounds), { chunk: 16 }),
    });
  });
  return captured;
}

async function seedSettings(page: Page, extra: Record<string, unknown>): Promise<void> {
  await page.addInitScript(
    (settings) => {
      window.localStorage.setItem("vera.settings.v1", JSON.stringify(settings));
    },
    {
      apiKey: "sk-ant-e2e-0000",
      keyValidatedAt: "2026-10-02T10:00:00.000Z",
      learnerName: "Simone",
      ...extra,
    },
  );
}

/** Every test runs with the fake Web Speech engines: no real audio in CI. */
async function fakeSpeech(page: Page, msPerWord = 20): Promise<void> {
  await page.addInitScript(installFakeSpeech, { msPerWord, boundaries: true });
}

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SHOTS, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

test.describe("giro completo in modalità testo", () => {
  test("parlo scrivendo, Vera risponde a voce nelle due lingue, la stoffa cresce dopo la ripetizione", async ({
    page,
  }, info) => {
    await seedSettings(page, { textMode: true });
    await fakeSpeech(page);
    const captured = await mockClaude(page);
    await page.goto("./");

    const state = page.locator(".loom-state");
    await expect(state).toHaveText(/PRONTA/);
    await shot(page, `${info.project.name}-01-pronta`);

    await page.locator(".loom-threshold").click();
    await expect(state).toHaveText(/VERA PENSA|VERA PARLA/);
    await expect(page.locator(".loom-vera .loom-seg").first()).toContainText("Ciao, sono Vera");
    await expect(page.locator(".loom-vera .loom-seg[data-kind='MODEL']")).toContainText("Hello, I'm Simone.");
    await shot(page, `${info.project.name}-02-parla`);

    await expect(state).toHaveText(/ASCOLTO/, { timeout: 15_000 });
    await shot(page, `${info.project.name}-03-ascolto`);

    // Text mode keeps Vera's voice: the greeting went through the synthesizer.
    const spoken = await page.evaluate(() => window.__veraFake?.utterances ?? []);
    expect(spoken.some((u) => u.lang === "it-IT" && u.text.includes("Ciao, sono Vera"))).toBe(true);

    const input = page.locator(".loom-textinput");
    await input.fill("I have thirty years");
    await input.press("Enter");
    await expect(page.locator(".loom-transcript")).toContainText("I have thirty years");
    await expect(page.locator(".loom-vera .loom-seg[data-kind='MODEL']")).toContainText(
      "I am thirty years old.",
    );
    await expect(state).toHaveText(/ASCOLTO/, { timeout: 15_000 });
    // Nothing is woven until the learner can say it.
    await expect(page.locator(".loom-row")).toHaveCount(0);

    await input.fill("I am thirty years old");
    await input.press("Enter");
    await expect(page.locator(".loom-row")).toHaveCount(1);
    await expect(page.locator(".loom-row").first()).toContainText("I am thirty years old.");
    await expect(state).toHaveText(/ASCOLTO/, { timeout: 15_000 });
    await shot(page, `${info.project.name}-04-stoffa`);

    expect(captured.bodies.length).toBe(3);
    const first = captured.bodies[0] as {
      system: Array<{ cache_control?: unknown }>;
      output_config: { format: { type: string } };
    };
    expect(first.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(first.output_config.format.type).toBe("json_schema");
    const second = captured.bodies[1] as { messages: Array<{ role: string; content: unknown }> };
    expect(second.messages.length).toBe(3);
    expect(second.messages[2]?.content).toContain("<learner_card>");
    expect(second.messages[2]?.content).toContain("I have thirty years");
    // The last history message carries the cache breakpoint; the new one never does.
    const third = captured.bodies[2] as {
      messages: Array<{ role: string; content: string | Array<{ cache_control?: unknown }> }>;
    };
    expect(third.messages.length).toBe(5);
    const lastHistory = third.messages[3]?.content;
    expect(Array.isArray(lastHistory) && lastHistory[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(typeof third.messages[4]?.content).toBe("string");

    await expect(page.locator(".loom-header")).toContainText("$");
  });

  test("tema scuro e movimento ridotto", async ({ page }, info) => {
    await seedSettings(page, { textMode: true, theme: "dark" });
    await fakeSpeech(page);
    await mockClaude(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("./");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.locator(".loom-threshold").click();
    await expect(page.locator(".loom-vera .loom-seg[data-kind='MODEL']")).toContainText("Hello");
    await shot(page, `${info.project.name}-05-scuro-ridotto`);
  });

  test("etichetta di composizione: diagnostica copiabile senza segreti, provini delle voci", async ({
    page,
  }, info) => {
    await seedSettings(page, { textMode: true });
    await fakeSpeech(page);
    await mockClaude(page);
    await page.goto("./");
    await page.locator(".loom-header .loom-meter").click();
    const diag = page.locator(".label-diag");
    await expect(diag).toBeVisible();
    const text = await diag.innerText();
    expect(text).toContain("Vera · etichetta diagnostica");
    expect(text).not.toContain("sk-ant-e2e-0000");
    // The voice section reads the engine's voices at the first opening.
    const voices = page.locator(".label-section[data-section='voce']");
    await expect(voices).toContainText("Fake Kate");
    await expect(voices).toContainText("Fake Alice");
    await expect(voices).not.toContainText("non riesco a leggere le voci");
    await shot(page, `${info.project.name}-06-etichetta`);
  });

  test("primo avvio senza chiave: il controllo grande porta alla chiave", async ({ page }, info) => {
    await seedSettings(page, { apiKey: "", keyValidatedAt: null, textMode: true });
    await fakeSpeech(page);
    await mockClaude(page);
    await page.goto("./");
    await expect(page.locator(".loom-state")).toHaveText(/SERVE LA CHIAVE/);
    const threshold = page.locator(".loom-threshold");
    await expect(threshold).toHaveText(/Inserisci la chiave API/);
    await threshold.click();
    const keyInput = page.locator(".label-section[data-section='chiave'] input");
    await expect(keyInput).toBeVisible();
    await expect(keyInput).toBeFocused();
    await expect(keyInput).toHaveAttribute("autocomplete", "one-time-code");
    await shot(page, `${info.project.name}-08-chiave`);
  });

  test("la stoffa scorre al suo interno: soglia e aiuti restano sullo schermo", async ({ page }, info) => {
    await seedSettings(page, { textMode: true });
    await fakeSpeech(page);
    await mockClaude(page);
    await page.goto("./");
    const state = page.locator(".loom-state");
    await page.locator(".loom-threshold").click();
    await expect(state).toHaveText(/ASCOLTO/, { timeout: 15_000 });
    const input = page.locator(".loom-textinput");
    for (let round = 0; round < 3; round += 1) {
      await input.fill("more");
      await input.press("Enter");
      await expect(page.locator(".loom-row")).toHaveCount(5 * (round + 1));
      await expect(state).toHaveText(/ASCOLTO/, { timeout: 15_000 });
    }
    await expect(page.locator(".loom-threshold")).toBeInViewport();
    await expect(page.locator(".loom-help-btn[data-help='REPEAT']")).toBeInViewport();
    await expect(page.locator(".loom-textinput")).toBeInViewport();
    const scrolls = await page.evaluate(() => {
      const cloth = document.querySelector(".loom-cloth");
      return cloth !== null && cloth.scrollHeight > cloth.clientHeight + 1;
    });
    expect(scrolls).toBe(true);
    const pageScrolls = await page.evaluate(
      () => document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
    );
    expect(pageScrolls).toBe(false);
    await shot(page, `${info.project.name}-09-stoffa-lunga`);
  });

  test("troppe richieste: riprova da sola dopo retry-after e il giro continua", async ({ page }) => {
    await seedSettings(page, { textMode: true });
    await fakeSpeech(page);
    const captured = await mockClaude(page, {
      failFirst: {
        status: 429,
        headers: { "retry-after": "1" },
        body: JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "This request would exceed your rate limit" },
        }),
      },
    });
    await page.goto("./");
    await page.locator(".loom-threshold").click();
    await expect(page.locator(".loom-notice")).toContainText(/riprovo tra 1 s/);
    await expect(page.locator(".loom-vera .loom-seg[data-kind='MODEL']")).toContainText("Hello", {
      timeout: 15_000,
    });
    await expect(page.locator(".loom-state")).toHaveText(/ASCOLTO/, { timeout: 15_000 });
    expect(captured.bodies.length).toBe(2);
  });
});

test.describe("giro completo a voce (motori finti)", () => {
  test("ascolta, risponde a voce per lingua, riapre il microfono", async ({ page }, info) => {
    await seedSettings(page, { textMode: false, voiceEn: "fake-en-gb", voiceIt: "fake-it" });
    await fakeSpeech(page);
    const captured = await mockClaude(page);
    await page.goto("./");

    const state = page.locator(".loom-state");
    await expect(state).toHaveText(/PRONTA/);
    await page.locator(".loom-threshold").click();
    await expect(state).toHaveText(/ASCOLTO/, { timeout: 15_000 });

    const spoken = await page.evaluate(() => window.__veraFake?.utterances ?? []);
    expect(spoken.some((u) => u.lang === "it-IT" && u.text.includes("Ciao, sono Vera"))).toBe(true);
    expect(spoken.some((u) => u.lang === "en-GB" && u.text.includes("Hello"))).toBe(true);
    expect(spoken.find((u) => u.lang === "it-IT")?.voice).toBe("Fake Alice");
    expect(spoken.find((u) => u.lang === "en-GB")?.voice).toBe("Fake Kate");

    const recognitions = await page.evaluate(() => window.__veraFake?.recognitions ?? []);
    // The greeting comes first: the recognizer opens only after it, in English.
    expect(recognitions.length).toBe(1);
    expect(recognitions.at(-1)?.lang).toBe("en-GB");
    await shot(page, `${info.project.name}-07-voce-ascolto`);

    await page.evaluate(() => window.__veraFake?.recognize("I have thirty years"));
    await expect(page.locator(".loom-transcript")).toContainText("I have thirty years");
    await expect(page.locator(".loom-vera .loom-seg[data-kind='MODEL']")).toContainText(
      "I am thirty years old.",
    );
    await expect(state).toHaveText(/ASCOLTO/, { timeout: 15_000 });
    expect(captured.bodies.length).toBe(2);

    await page.locator(".loom-threshold").click();
    await expect(state).toHaveText(/PRONTA/);
  });

  test("«Ripeti» mentre Vera parla ricomincia la stessa risposta e poi riapre il microfono", async ({
    page,
  }) => {
    await seedSettings(page, { textMode: false });
    await fakeSpeech(page, 150);
    await mockClaude(page);
    await page.goto("./");

    const state = page.locator(".loom-state");
    await page.locator(".loom-threshold").click();
    await expect(state).toHaveText(/VERA PARLA/, { timeout: 15_000 });
    await expect
      .poll(async () => (await page.evaluate(() => window.__veraFake?.utterances.length ?? 0)) >= 1)
      .toBe(true);
    await page.locator(".loom-help-btn[data-help='REPEAT']").click();
    await expect(state).toHaveText(/ASCOLTO/, { timeout: 20_000 });
    const spoken = await page.evaluate(() => window.__veraFake?.utterances ?? []);
    expect(spoken.filter((u) => u.text.includes("Ciao, sono Vera")).length).toBe(2);
    expect(spoken.filter((u) => u.text.includes("Hello")).length).toBeGreaterThanOrEqual(1);
    // Back in listening: exactly one recognizer open, nothing left speaking.
    expect(await page.evaluate(() => window.__veraFake?.activeCount ?? -1)).toBe(1);
    expect(await page.evaluate(() => window.speechSynthesis.speaking || window.speechSynthesis.pending)).toBe(
      false,
    );
  });

  test("premi e parla: la prima pressione fa salutare Vera, poi si aspetta la pressione", async ({
    page,
  }) => {
    await seedSettings(page, { textMode: false, listenMode: "push" });
    await fakeSpeech(page);
    await mockClaude(page);
    await page.goto("./");
    const state = page.locator(".loom-state");
    const threshold = page.locator(".loom-threshold");
    await expect(state).toHaveText(/PRONTA/);
    await expect(threshold).toHaveText(/Tocca per iniziare/);
    await threshold.click();
    await expect(state).toHaveText(/VERA PENSA|VERA PARLA/);
    await expect(state).toHaveText(/PRONTA/, { timeout: 15_000 });
    await expect(threshold).toHaveText(/Tieni premuto e parla/);
    const spoken = await page.evaluate(() => window.__veraFake?.utterances ?? []);
    expect(spoken.some((u) => u.text.includes("Ciao, sono Vera"))).toBe(true);
    expect(await page.evaluate(() => window.__veraFake?.recognitions.length ?? -1)).toBe(0);
  });
});
