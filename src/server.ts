import 'dotenv/config';
import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import OpenAI from 'openai';
import { Runner, Agent } from '@openai/agents';

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

const app = express();
app.use(bodyParser.json({ limit: '20mb' }));

// Enforce JSON to avoid body parse surprises from Make/Telegram
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

    // Collapse input to a single user text for maximum compatibility
    const parts: string[] = [];
    if (text?.trim()) parts.push(text.trim());
    if (files?.length) {
      parts.push('Файлы:\n' + files.map((f: FileItem) => `- ${f.name}: ${f.url}`).join('\n'));
    }
    const userText = parts.join('\n\n');

    const conversation_id = String(chat_id ?? 'no-chat');

    const result = runner
      ? await (runner as any).run(agent, userText, {
          ...(client ? { client } : {}),
          // support both modern and older SDK shapes
          conversation_id,
          config: { conversation_id }
        } as any)
      : await agent.run({ input: [{ role: 'user', content: userText }], conversation_id });

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


const jobs = new Map<string, { status: 'pending'|'done'|'error'; result?: any; error?: string }>();

function newJobId() {
  return Math.random().toString(36).slice(2);
}

app.post('/run_async', async (req, res) => {
  const { chat_id, text, files } = req.body || {};
  const parts: string[] = [];
  if (text?.trim()) parts.push(text.trim());
  if (files?.length) {
    parts.push('Файлы:\n' + files.map((f:any) => `- ${f.name}: ${f.url}`).join('\n'));
  }
  const userText = parts.join('\n\n');
  const conversation_id = String(chat_id ?? 'no-chat');

  const job_id = newJobId();
  jobs.set(job_id, { status: 'pending' });

  // фоном
  (async () => {
    try {
      const result = runner
        ? await (runner as any).run(agent, userText, {
            ...(client ? { client } : {}),
            conversation_id,
            config: { conversation_id }
          } as any)
        : await agent.run({ input: [{ role: 'user', content: userText }], conversation_id });

      const answer =
        (result as any)?.output_text ||
        (result as any)?.content?.[0]?.text ||
        (typeof result === 'string' ? result : JSON.stringify(result));

      jobs.set(job_id, { status: 'done', result: { answer } });
    } catch (err:any) {
      jobs.set(job_id, { status: 'error', error: err?.message || 'Agent error' });
    }
  })();

  res.json({ ok: true, job_id });
});

app.get('/result', (req, res) => {
  const job_id = String(req.query.job_id || '');
  const job = jobs.get(job_id);
  if (!job) return res.status(404).json({ ok: false, error: 'job not found' });
  res.json({ ok: true, ...job });
});
