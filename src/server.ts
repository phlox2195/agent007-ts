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

app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <title>Web Echo Splitter</title>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:900px;margin:40px auto;padding:0 16px}
    textarea{width:100%;height:220px}
    .row{display:flex;gap:12px;margin:12px 0}
    .btn{padding:10px 14px;border:1px solid #ccc;border-radius:10px;background:#fafafa;cursor:pointer}
    .out{white-space:pre-wrap;border:1px solid #eee;border-radius:10px;padding:12px;background:#fff}
    .chunk{border:1px dashed #ccc;border-radius:10px;padding:10px;margin:8px 0;background:#f9f9f9}
    .muted{color:#666;font-size:12px}
  </style>
</head>
<body>
  <h1>Web Echo Splitter</h1>
  <p>Вставьте длинный текст — получайте «сообщения» как будет в боте.</p>
  <textarea id="inp" placeholder="Вставьте длинный ответ здесь..."></textarea>
  <div class="row">
    <button class="btn" id="btnSplit">POST /split → JSON</button>
    <button class="btn" id="btnStream">SSE /stream → поступательно</button>
  </div>
  <div id="out" class="out"></div>

<script>
const out = document.getElementById('out');
function showChunks(chunks){
  out.innerHTML = '<div class="muted">Всего частей: '+chunks.length+'</div>' +
    chunks.map((c,i)=>'<div class="chunk"><b>#'+(i+1)+'</b><br>'+c.replace(/</g,'&lt;')+'</div>').join('');
}

document.getElementById('btnSplit').onclick = async () => {
  const text = document.getElementById('inp').value || '';
  const r = await fetch('/split', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ text })
  });
  const data = await r.json();
  showChunks(data.chunks || []);
};
document.getElementById('btnStream').onclick = async () => {
  out.textContent = 'Подключаюсь к /stream ...';
  const text = document.getElementById('inp').value || '';
  const r = await fetch('/stream', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ text })
  });
  if (!r.ok) {
    out.textContent = 'Ошибка: ' + r.status + ' ' + r.statusText;
    return;
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  out.innerHTML = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream:true });
    // SSE фреймы: строки вида "data: <json>\\n\\n"
    const parts = buf.split('\\n\\n');
    buf = parts.pop();
    for (const frame of parts) {
      const line = frame.split('\\n').find(x=>x.startsWith('data: '));
      if (!line) continue;
      const payload = JSON.parse(line.slice(6));
      const el = document.createElement('div');
      el.className='chunk';
      el.innerHTML = '<b>#'+payload.index+'</b><br>' + (payload.text||'').replace(/</g,'&lt;');
      out.appendChild(el);
    }
  }
};
</script>
</body>
</html>`);
});
