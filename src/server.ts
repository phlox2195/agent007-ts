// src/server.ts
import 'dotenv/config';
import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import OpenAI from 'openai';
import { Runner, Agent } from '@openai/agents';

type FileItem = { name: string; url: string };
type RunBody = { chat_id?: string | number; text?: string; files?: FileItem[] };

let agent: Agent | any;
let runner: Runner | any = null; // держим как any — меньше сюрпризов при смене версий SDK
let client: OpenAI | null = null;

async function loadAgent() {
  // после сборки TS -> JS путём остаётся .js
  const mod = await import('./agent/exported-agent.js');
  // exported-agent должен экспортировать getAgent(getRunner?)
  // поддержим оба варианта: объект или фабрика
  const maybeAgent = (mod.default ?? mod.agent ?? mod.getAgent?.()) as Agent | any;
  if (!maybeAgent) throw new Error('Agent not found in ./agent/exported-agent.js');
  return maybeAgent;
}

function getRunner() {
  if (runner) return runner;
  runner = new Runner({
    traceMetadata: { __trace_source__: 'server' }
  });
  return runner;
}

/** Извлекаем человекочитаемый текст из ответа Runner/SDK */
function extractText(raw: any): string {
  let r: any = raw;
  if (!r) return '';

  // если прилетела строка — это может быть уже текст или сериализованный state
  if (typeof r === 'string') {
    const looksLikeJson = r.trim().startsWith('{') && r.includes('"state"');
    if (looksLikeJson) {
      try { r = JSON.parse(r); } catch { return r.trim(); }
    } else {
      return r.trim();
    }
  }

  const pluck = (arr: any[] = []) =>
    arr.map((c: any) => c?.text ?? c?.output_text ?? '')
       .filter(Boolean)
       .join('\n\n')
       .trim();

  // простые формы
  if (typeof r.output_text === 'string' && r.output_text.trim()) return r.output_text.trim();
  if (typeof r.finalOutput === 'string' && r.finalOutput.trim()) return r.finalOutput.trim();
  if (Array.isArray(r.content)) {
    const t = pluck(r.content);
    if (t) return t;
  }

  // формы Runner/SDK через state/newItems/modelResponses
  const s = r.state ?? r;

  if (typeof s?.finalOutput === 'string' && s.finalOutput.trim()) return s.finalOutput.trim();

  if (Array.isArray(s?.newItems)) {
    const t = s.newItems
      .flatMap((it: any) => it?.content ?? it?.rawItem?.content ?? [])
      .map((c: any) => c?.text ?? c?.output_text ?? '')
      .filter(Boolean)
      .join('\n\n')
      .trim();
    if (t) return t;
  }

  if (Array.isArray(s?.modelResponses)) {
    const t = s.modelResponses
      .flatMap((m: any) => m?.content ?? [])
      .map((c: any) => c?.text ?? c?.output_text ?? '')
      .filter(Boolean)
      .join('\n\n')
      .trim();
    if (t) return t;
  }

  // последний шанс — коротко возвращаем JSON (чтобы телеге не улетала «простыня»)
  try { return JSON.stringify(r, null, 2).slice(0, 3500); }
  catch { return String(r).slice(0, 3500); }
}

const app = express();
app.use(bodyParser.json({ limit: '12mb' }));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/run', async (req: Request<{}, {}, RunBody>, res: Response) => {
  try {
    if (!agent) agent = await loadAgent();
    if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const r = getRunner();

    const { text, files = [] } = req.body || {};
    const userInput: any[] = [];

    if (text && String(text).trim()) {
      userInput.push({ role: 'user', content: [{ type: 'output_text', text: String(text) }] });
    }

    // передаём файлы как ссылки (агент их сам подтянет/проинтерпретирует, если так настроен)
    for (const f of files) {
      if (!f?.url) continue;
      userInput.push({
        role: 'user',
        content: [{ type: 'input_text', text: `file: ${f.name || 'attachment'} -> ${f.url}` }]
      });
    }

    // запустим раннер
    const result = await r.run(agent, userInput, {
      model: 'gpt-5', // можно переопределять env-переменной
      modelSettings: {
        reasoning: { effort: 'low' },
        store: false,
        maxOutputTokens: 1500
      }
    });

    const answer = extractText(result);
    return res.json({ ok: true, answer });
  } catch (err: any) {
    console.error('[/run] ERROR', err?.message, err?.stack);
    return res.status(500).json({ ok: false, error: err?.message || 'Agent error' });
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Agent service listening on :${port}`));
