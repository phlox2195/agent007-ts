import 'dotenv/config';
import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';

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

async function loadAgent() {
  try {
    const mod = await import("./agent/exported-agent.js"); // после сборки будет .js
    agent = (mod as any).default ?? (mod as any);
    console.log("[agent] Loaded Agent Builder export.");
  } catch {
    const mod = await import("./agent/fallback-agent.js");
    agent = (mod as any).default ?? (mod as any);
    console.warn("[agent] Using fallback agent.");
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
    const { chat_id, text, files } = req.body as RunRequestBody;
    const input = normalizeInput(text, files);
    const result = await agent.run({
      input,
      conversation_id: String(chat_id ?? 'no-chat')
    });
    const answer =
      result?.output_text ||
      result?.content?.[0]?.text ||
      (typeof result === 'string' ? result : JSON.stringify(result));
    res.json({ ok: true, answer });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ ok: false, error: err?.message || 'Agent error' });
  }
});

app.get('/health', (_: Request, res: Response) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Agent service listening on :${port}`));
