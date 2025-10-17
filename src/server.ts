// server.ts — минимальный синхронный сервер только с /run
import express, { Request, Response } from "express";
import cors from "cors";
import bodyParser from "body-parser";

// ===== Настройки окружения =====
const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const AGENT_ID = process.env.AGENT_ID || process.env.OPENAI_AGENT_ID || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || ""; // опционально (если свой прокси)

// ===== Типы входа =====
type FileRef = { name?: string; url: string };
type RunBody = {
  text?: string;
  files?: FileRef[];
  chat_id?: string | number; // прозрачно прокидывается, если нужно
  meta?: Record<string, any>;
};

// ===== Глобальные синглтоны =====
let runner: any /* Агент/Раннер из SDK */ = null;

// ===== Вспомогалки =====
function assertEnv() {
  if (!AGENT_ID) throw new Error("AGENT_ID (или OPENAI_AGENT_ID) не задан");
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY не задан");
}

async function ensureRunner() {
  if (runner) return;

  assertEnv();

  // Инициализация клиента/раннера.
  // Ниже оставлено максимально совместимо с большинством SDK.
  // Если в твоём репо это по-другому, просто подставь свою функцию инициализации.
  const { AgentsClient } = require("@openai/agents"); // в твоём репо уже есть
  const client = new AgentsClient({
    apiKey: OPENAI_API_KEY,
    baseURL: OPENAI_BASE_URL || undefined,
  });

  const { AgentRunner } = require("@openai/agents/runner");
  runner = new AgentRunner({
    client,
    agentId: AGENT_ID,
  });

  console.log("[agent] runner is ready for agent:", AGENT_ID);
}

// Достаём человекочитаемый текст из результата SDK
function extractText(result: any): string {
  try {
    if (!result) return "Готово.";

    // 1) Наиболее частые поля SDK
    if (typeof result.output_text === "string" && result.output_text.trim())
      return result.output_text;

    const c0 = result?.content?.[0];
    if (typeof c0?.text === "string" && c0.text.trim()) return c0.text;

    // 2) В некоторых реализациях есть final_output
    if (typeof result?.final_output === "string" && result.final_output.trim())
      return result.final_output;

    // 3) Попробуем из последнего modelResponse/tool шага
    const mr =
      (Array.isArray(result?.modelResponses) &&
        result.modelResponses[result.modelResponses.length - 1]) ||
      null;
    const mrText =
      mr?.output_text || mr?.content?.[0]?.text || mr?.message?.content;
    if (typeof mrText === "string" && mrText.trim()) return mrText;

    // 4) Сам результат строкой
    if (typeof result === "string") return result;

    return "Готово.";
  } catch {
    return "Готово.";
  }
}

// ===== Приложение =====
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ---- ЕДИНСТВЕННАЯ рабочая точка: /run ----
app.post(
  "/run",
  async (req: Request<{}, {}, RunBody>, res: Response): Promise<any> => {
    try {
      await ensureRunner();

      const { text = "", files = [] } = req.body || {};

      const attachments =
        files?.map((f) => ({ url: f.url, name: f.name || undefined })) ?? [];

      // Один вызов агента на запрос
      const result = await runner.run({
        input: text || "",
        attachments,
        // при желании: max_output_tokens: 1200, temperature: 0.7, и т.д.
      });

      const answer = extractText(result);
      return res.json({ ok: true, answer });
    } catch (err: any) {
      console.error("[/run] error:", err);
      return res
        .status(500)
        .json({ ok: false, error: err?.message || "Agent error" });
    }
  }
);

// ---- Заглушки: полностью отключаем async-режим ----
app.post("/run_async", (_req, res) => {
  return res
    .status(410)
    .json({ ok: false, error: "run_async disabled; use /run" });
});

app.get("/result", (_req, res) => {
  return res
    .status(410)
    .json({ ok: false, error: "result polling disabled; use /run" });
});

// ---- Старт ----
app.listen(PORT, () =>
  console.log(`Agent service listening on :${PORT} (sync /run only)`)
);
