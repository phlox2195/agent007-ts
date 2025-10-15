import 'dotenv/config';
import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import OpenAI from 'openai';
import { Runner } from '@openai/agents';

interface FileItem {
  name: string;
  url: string;
}
interface RunRequestBody {
  chat_id?: string | number;
  text?: string;
  files?: FileItem[];
}

let agent: any;
let runner: Runner | null = null;

async function loadAgent() {
  try {
    const mod = await import('./agent/exported-agent.js'); // после сборки будет .js
    agent = (mod as any).default ?? (mod as any);
    // Если это экспорт из Agent Builder (Agent), нужен Runner
    if (!agent?.run) {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      runner = new Runner({ client });
      console.log('[agent] Loaded Agent (SDK) + Runner.');
    } else {
      console.log('[agent] Loaded fallback-like agent with .run().');
    }
  } catch {
    // Фолбэк-агент имеет .run()
    const mod = await import('./agent/fallback-agent.js');
    agent = (mod as any).default ?? (mod as any);
    runner = null;
    console.warn('[agent] Using fallback agent.');
  }
}
await loadAgent();


const app = express();
app.use(bodyParser.json({ limit: '20mb' }));

function normalizeInput(text?: string, files?: FileItem[]) {
  const msgs: any[] = [];
  if (text?.trim()) msgs.push({ role: 'user', content: text });
  if (files?.length) {
    msgs.push({
      role: 'user',
      content: 'Файлы от пользователя:\n' + files.map(f => `- ${f.name}: ${f.url}`).join('\n')
    });
  }
  return msgs;
}

app.post('/run', async (req: Request, res: Response) => {
  try {
    const { chat_id, text, files } = req.body || {};

    const input: any[] = [];
    if (text?.trim()) input.push({ role: 'user', content: text });
    if (files?.length) {
      input.push({
        role: 'user',
        content: 'Файлы:\n' + files.map((f: any) => `- ${f.name}: ${f.url}`).join('\n')
      });
    }

    const options = { input, conversation_id: String(chat_id ?? 'no-chat') };

    const result = runner
      ? await runner.run({ agent, ...options })
      : await agent.run(options);

    const answer =
      result?.output_text ||
      result?.content?.[0]?.text ||
      (typeof result === 'string' ? result : JSON.stringify(result));

    return res.json({ ok: true, answer });
  } catch (err: any) {
    console.error('[/run] ERROR', err?.message, err?.stack);
    return res.status(500).json({ ok: false, error: err?.message || 'Agent error' });
  }
});


app.get('/health', (_: Request, res: Response) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Agent service listening on :${port}`));
