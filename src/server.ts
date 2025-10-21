import 'dotenv/config';
import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import OpenAI from 'openai';
import { Runner, Agent } from '@openai/agents';
import axios from "axios";
import fs from "fs";
import path from "path";

type FileItem = { name: string; url: string };
type RunBody = { chat_id?: string | number; text?: string; files?: FileItem[] };

let agent: any;
let runner: any = null; // keep as any to avoid SDK overload issues across versions
let client: OpenAI | null = null;

async function loadAgent() {
  try {
    const mod = await import('./agent/exported-agent.js'); // after build .ts -> .js
    let exported = (mod as any).default ?? (mod as any);

    // If export is a factory, call it to get an Agent/definition
    if (typeof exported === 'function') {
      exported = await exported();
    }

    // Ensure we have an Agent instance; if it's a definition, wrap it
    const isAgentInstance =
      exported instanceof Agent ||
      (exported && typeof (exported as any).getEnabledHandoffs === 'function');

    if (!isAgentInstance) {
      try {
        exported = new (Agent as any)(exported);
      } catch {
        if (typeof (Agent as any).fromDefinition === 'function') {
          exported = (Agent as any).fromDefinition(exported);
        } else {
          throw new Error('Exported module is not an Agent and cannot be wrapped.');
        }
      }
    }

    agent = exported as Agent;

    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    runner = new Runner(); // pass client in run(...)
    console.log('[agent] Loaded Agent (SDK) + Runner');
  } catch (e: any) {
    console.warn('[agent] Fallback path:', e?.message);
    const mod = await import('./agent/fallback-agent.js');
    agent = (mod as any).default ?? (mod as any);
    runner = null;
    client = null;
    console.warn('[agent] Using fallback agent');
  }
}
await loadAgent();

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
app.use(express.json({ limit: "20mb" })); // тут только JSON (текст, ссылки и т. п.)

async function uploadToOpenAIFromUrl(url: string, filenameHint = "file.pdf") {
  const tmp = path.join("/tmp", `${Date.now()}_${path.basename(filenameHint)}`);
  const resp = await axios.get(url, { responseType: "stream" });
  await new Promise<void>((res, rej) => {
    const w = fs.createWriteStream(tmp);
    resp.data.pipe(w);
    w.on("finish", () => res());
    w.on("error", rej);
  });
  const file = await client.files.create({
    file: fs.createReadStream(tmp),
    purpose: "assistants", // верно для Agents/Assistants
  });
  return file.id;
}


// Enforce JSON to avoid body parse surprises from Make/Telegram
app.use((req, res, next) => {
  if (!req.is('application/json')) {
    return res.status(415).json({ ok: false, error: 'Content-Type must be application/json' });
  }
  next();
});

app.get('/health', (_: Request, res: Response) => res.json({ ok: true }));



app.post("/run", async (req, res) => {
  try {
    const { text = "", file_urls = [], file_ids = [] } = req.body as {
      text: string;
      file_urls?: string[];
      file_ids?: string[];
    };

    // 1) если пришли URL — скачиваем и загружаем их в OpenAI
    const uploadedIds: string[] = [];
    for (const url of file_urls) {
      const id = await uploadToOpenAIFromUrl(url);
      uploadedIds.push(id);
    }
    const allIds = [...file_ids, ...uploadedIds];

    // 2) (опционально) кинем эти файлы также в vector store для file_search
    const vs = await client.vectorStores.create({ name: `vs_${Date.now()}` });
    await Promise.all(
      allIds.map(async (fid) => {
        await client.vectorStores.files.createAndPoll(vs.id, { file_id: fid });
      })
    );

    const runner = new Runner({ client });

    const out = await runner.run(agent, {
      input: [{ role: "user", content: [{ type: "input_text", text }] }],
      tool_config: { file_search: { vector_store_ids: [vs.id] } },
      attachments: allIds.map((id) => ({
        file_id: id,
        tools: [{ type: "code_interpreter" }, { type: "file_search" }],
      })),
    });

    res.json(out);
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e?.message ?? "run_failed" });
  }
});


const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Agent service listening on :${port}`));


const jobs = new Map<string, { status: 'pending'|'done'|'error'; result?: any; error?: string }>();

function newJobId() {
  return Math.random().toString(36).slice(2);
}
