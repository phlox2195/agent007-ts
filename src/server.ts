import 'dotenv/config';
import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import OpenAI from 'openai';
import { Runner } from '@openai/agents';

let agent: any;
let runner: Runner | null = null;
let client: OpenAI | null = null;

async function loadAgent() {
  try {
    const mod = await import('./agent/exported-agent.js'); // после сборки .ts -> .js
    agent = (mod as any).default ?? (mod as any);

    // Экспорт из Agent Builder -> это Agent (без .run)
    // Для него используем Runner
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    runner = new Runner(); // ⬅️ без аргументов
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

app.get('/health', (_: Request, res: Response) => res.json({ ok: true }));

app.post('/run', async (req, res) => {
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

    const inputMsgs = input;
    const opts = {
      conversation_id: String(chat_id ?? 'no-chat'),
      ...(client ? { client } : {})
    };

    const result = runner
      ? await runner.run(agent, inputMsgs, opts)
      : await agent.run({ input: inputMsgs, conversation_id: opts.conversation_id });

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


const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Agent service listening on :${port}`));
