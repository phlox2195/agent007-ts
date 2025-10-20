import 'dotenv/config';
import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import OpenAI from 'openai';
import { Runner, Agent } from '@openai/agents';

const app = express();
const PORT = Number(process.env.PORT) || 10000;

app.use(express.json({ limit: "50mb" }));

app.get("/", (_req, res) => res.send("OK"));

app.post("/run", async (req, res) => {
  try {
    const { text, file_ids } = req.body as { text?: string; file_ids?: string[] };
    if (!text?.trim()) return res.status(400).json({ error: "Missing 'text'" });
    if (!file_ids?.length) return res.status(400).json({ error: "Missing 'file_ids'" });

    const out = await runAgent({ text, file_ids });
    res.json({ text: out.output_text || "Текст пуст." });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e?.message ?? "Agent run failed" });
  }
});

app.listen(PORT, () => console.log(`listening on :${PORT}`));
