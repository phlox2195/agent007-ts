// src/server.ts
import express from "express";
import fs from "fs";
import path from "path";
import axios from "axios";
import { OpenAI } from "openai";
import { Runner } from "@openai/agents";
import { buildAgentWithVS } from "./agent/exported-agent.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// 1) Гарантируем Vector Store: берём из ENV, иначе создаём новый
async function ensureVectorStoreId(): Promise<string> {
  const provided = process.env.VECTOR_STORE_ID?.trim();
  if (provided) {
    try {
      await client.vectorStores.retrieve(provided);
      console.log(`[VS] Using existing VECTOR_STORE_ID=${provided}`);
      return provided;
    } catch {
      console.warn(`[VS] Provided VECTOR_STORE_ID=${provided} not found — will create a new one`);
    }
  }
  const vs = await client.vectorStores.create({ name: `agent007_store_${Date.now()}` });
  console.log(`[VS] Created vector store: ${vs.id}. Save it to env VECTOR_STORE_ID`);
  return vs.id;
}

const runner = new Runner();
const app = express();
app.use(express.json({ limit: "20mb" }));

async function uploadToOpenAIFromUrl(url: string, filenameHint = "file.pdf") {
  const tmp = path.join("/tmp", `${Date.now()}_${path.basename(filenameHint)}`);
  const resp = await axios.get(url, { responseType: "stream", timeout: 60_000 });
  await new Promise<void>((resolve, reject) => {
    const w = fs.createWriteStream(tmp);
    resp.data.pipe(w);
    w.on("finish", () => resolve());
    w.on("error", reject);
  });
  const file = await client.files.create({ file: fs.createReadStream(tmp), purpose: "assistants" });
  return file.id;
}

// Совет: создайте VS один раз при старте сервиса
let VS_ID_PROMISE = ensureVectorStoreId();

app.post("/run", async (req, res) => {
  try {
    const { text = "", file_urls, file_ids } = req.body as any;

    const fileUrls: string[] = Array.isArray(file_urls)
      ? file_urls
      : (typeof file_urls === "string" && file_urls ? [file_urls] : []);

    const openAiIds: string[] = Array.isArray(file_ids)
      ? file_ids
      : (typeof file_ids === "string" && file_ids ? [file_ids] : []);

    // 2) Загружаем все Telegram-URL в OpenAI
    const uploadedIds: string[] = [];
    for (const url of fileUrls) {
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue; // защита от мусора
      const fid = await uploadToOpenAIFromUrl(url);
      uploadedIds.push(fid);
    }

    const allFileIds: string[] = [...openAiIds, ...uploadedIds];
    const vsId = await VS_ID_PROMISE;
    // 3) докладываем каждый файл в постоянный VS (для file_search)
    if (allFileIds.length) {
  await Promise.all(
    allFileIds.map(async (fid) => {
      try {
        await client.vectorStores.files.createAndPoll(vsId, { file_id: fid });
      } catch (e: any) {
        const msg = String(e?.message ?? "");
        if (e?.status !== 409 && !/already exists/i.test(msg)) throw e;
      }
    })
  );
}

    // 4) формируем input: текст + файлы (для доступа код-интерпретеру)
    type ContentItem =
      | { type: "input_text"; text: string }
      | { type: "input_file"; file: { id: string } };

    const content: ContentItem[] = [
      { type: "input_text", text },
      ...allFileIds.map((id): ContentItem => ({ type: "input_file", file: { id } })),
    ];

    // 5) создаём агента, знающего про наш VS
    const agent = buildAgentWithVS(vsId);

    // 6) запускаем
    const out = await runner.run(agent, [{ role: "user" as const, content }]);

    // (опционально) верните плоский текст
    // const plain = (out as any)?.output_text ?? JSON.stringify(out);
    // res.json({ text: plain });

    res.json(out);
  } 
  catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err?.message ?? "run_failed" });
  }
});

app.get("/healthz", (_req, res) => res.send("ok"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Agent service listening on :${PORT}`));
