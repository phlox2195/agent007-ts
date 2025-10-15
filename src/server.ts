import 'dotenv/config';
import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import OpenAI from 'openai';
import { Runner } from '@openai/agents';

type FileItem = { name: string; url: string };
type RunBody = { chat_id?: string | number; text?: string; files?: FileItem[] };

let agent: any;
let runner: Runner | null = null;
let client: OpenAI | null = null;

async function loadAgent() {
  try {
    const mod = await import('./agent/exported-agent.js'); // после сборки .ts -> .js
    agent = (mod as any).default ?? (mod as any);

    // Экспорт из Agent Builder -> это Agent (без .run) — используем Runner
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    runner = new Runner(); // без аргументов, клиент передаём в run(...)
    console.log('[agent] Loaded Agent (SDK) + Runner');
  } catch {
    // Фолбэк-агент имеет собственный .run()
    const mod = await import('./agent/fallback-agent.js');
    agent = (mod as any).default ?? (mod as any);
    runner = null;
    client = null;
    console.warn('[agent] Using fallback agent');
  }
}
await loadAgent();

const app = express();
app.use(bodyParser.json({ limit: '20mb' }));

// необязательная защита: требуем application/json
app.use((req, res, next) => {
  if (!req.is('application/json')) {
    return res.status(415).json({ ok: false, error: 'Content-Type must be application/json' });
  }
  next();
});

app.get('/health', (_: Request, res: Response) => res.json({ ok: true }));

app.post('/run', async (req: Request<{}, {}, RunBody>, res: Response) => {
  try {
    const { chat_id, text, files } = req.body || {};

    if (!text?.trim() && !(files?.length)) {
      return res.status(400).json({ ok: false, error: 'Empty input: provide text or files[]' });
    }

    const input: any[] = [];
    if (text?.trim()) input.push({ role: 'user', content: text });
    if (files?.length) {
      input.push({
        role: 'user',
        content: 'Файлы:\n' + files.map((f: FileItem) => `- ${f.name}: ${f.url}`).join('\n')
      });
    }

    const inputMsgs = input; // string | AgentInputItem[]
    const conversation_id = String(chat_id ?? 'no-chat');

    // для Agent SDK используем Runner.run(agent, input, options)
    // options: { client?, config: { conversation_id } }
    const result = runner
      ? await runner.run(agent, inputMsgs, {
          ...(client ? { client } : {}),
          config: { conversation_id }
        })
      // для fallback-агента используется его собственный .run({ input, conversation_id })
      : await agent.run({ input: inputMsgs, conversation_id });

    const answer =
      (result as any)?.output_text ||
      (result as any)?.content?.[0]?.text ||
      (typeof result === 'string' ? result : JSON.stringify(result));

    return res.json({ ok: true, answer });
  } catch (err: any) {
    console.error('[/run] ERROR', err?.message, err?.stack);
    return res.status(500).json({ ok: false, error: err?.message || 'Agent error' });
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Agent service listening on :${port}`));
