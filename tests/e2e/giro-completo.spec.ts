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
  learned: [{ text_en: "I am thirty years old.", gloss_it: "Ho trent'anni.", topic: "SMALL_TALK" }],
  about_learner: [],
  goal: { id: "g_a0_greet", status: "ONGOING" },
  closing: null,
};

interface Captured {
  readonly bodies: Array<Record<string, unknown>>;
}

async function mockClaude(page: Page): Promise<Captured> {
  const captured: Captured = { bodies: [] };
  await page.route(MESSAGES_URL, async (route: Route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 200,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "POST, OPTIONS",
        },
      });
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    captured.bodies.push(body);
    const messages = body.messages as Array<{ content: string }>;
    const last = messages[messages.length - 1]?.content ?? "";
    const reply = /thirty/i.test(last) ? CORRECTION : GREETING;
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
      body: anthropicSseBody(reply, { chunk: 16 }),
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

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SHOTS, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

test.describe("giro completo in modalità testo", () => {
  test("parlo scrivendo, Vera risponde nelle due lingue, la stoffa cresce", async ({ page }, info) => {
    await seedSettings(page, { textMode: true });
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

    const input = page.locator(".loom-textinput");
    await input.fill("I have thirty years");
    await input.press("Enter");
    await expect(page.locator(".loom-transcript")).toContainText("I have thirty years");
    await expect(page.locator(".loom-vera .loom-seg[data-kind='MODEL']")).toContainText(
      "I am thirty years old.",
    );
    await expect(state).toHaveText(/ASCOLTO/, { timeout: 15_000 });
    await expect(page.locator(".loom-row")).toHaveCount(1);
    await expect(page.locator(".loom-row").first()).toContainText("I am thirty years old.");
    await shot(page, `${info.project.name}-04-stoffa`);

    expect(captured.bodies.length).toBe(2);
    const first = captured.bodies[0] as {
      system: Array<{ cache_control?: unknown }>;
      output_config: { format: { type: string } };
    };
    expect(first.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(first.output_config.format.type).toBe("json_schema");
    const second = captured.bodies[1] as { messages: Array<{ role: string; content: string }> };
    expect(second.messages.length).toBe(3);
    expect(second.messages[2]?.content).toContain("<learner_card>");
    expect(second.messages[2]?.content).toContain("I have thirty years");

    await expect(page.locator(".loom-header")).toContainText("$");
  });

  test("tema scuro e movimento ridotto", async ({ page }, info) => {
    await seedSettings(page, { textMode: true, theme: "dark" });
    await mockClaude(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("./");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.locator(".loom-threshold").click();
    await expect(page.locator(".loom-vera .loom-seg[data-kind='MODEL']")).toContainText("Hello");
    await shot(page, `${info.project.name}-05-scuro-ridotto`);
  });

  test("etichetta di composizione: diagnostica copiabile senza segreti", async ({ page }, info) => {
    await seedSettings(page, { textMode: true });
    await mockClaude(page);
    await page.goto("./");
    await page.locator(".loom-header .loom-meter").click();
    const diag = page.locator(".label-diag");
    await expect(diag).toBeVisible();
    const text = await diag.innerText();
    expect(text).toContain("Vera · etichetta diagnostica");
    expect(text).not.toContain("sk-ant-e2e-0000");
    await shot(page, `${info.project.name}-06-etichetta`);
  });
});

test.describe("giro completo a voce (motori finti)", () => {
  test("ascolta, risponde a voce per lingua, riapre il microfono", async ({ page }, info) => {
    await seedSettings(page, { textMode: false, voiceEn: "fake-en-gb", voiceIt: "fake-it" });
    await page.addInitScript(installFakeSpeech, { msPerWord: 20, boundaries: true });
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
});
