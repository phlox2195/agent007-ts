import { OpenAI } from "openai";
import express from "express";
import { runAgent } from "./exported-agent.ts"; // <-- импортируем функцию

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const app = express();
const PORT = Number(process.env.PORT) || 10000;

app.use(express.json({ limit: "50mb" }));

app.post("/run", async (req, res) => {
  try {
    const { text, file_ids } = req.body as { text?: string; file_ids?: string[] };
    if (!text) return res.status(400).json({ error: "Missing 'text'" });
    if (!file_ids?.length) return res.status(400).json({ error: "Missing 'file_ids'" });

    const out = await runAgent(client, { text, file_ids });
    res.json({ text: out.output_text });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e?.message ?? "Agent run failed" });
  }
});

app.get("/", (_req, res) => res.send("OK"));
app.listen(PORT, () => console.log(`listening on :${PORT}`));
