import express from "express";
import fs from "fs";
import path from "path";
import axios from "axios";
import { OpenAI } from "openai";
import {
  Agent,
  Runner,
  AgentInputItem,
  fileSearchTool,
  codeInterpreterTool,
} from "@openai/agents";

// 1) Клиент OpenAI (ключ обязателен в env Render)
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

import agent from "./agent/exported-agent";

// 3) Runner без client в конфиге (иначе TS-ошибка)
const runner = new Runner();

const app = express();
app.use(express.json({ limit: "20mb" }));

// Утилита: скачать файл по URL -> загрузить в OpenAI -> вернуть file_id
async function uploadToOpenAIFromUrl(url: string, filenameHint = "file.pdf") {
  const tmp = path.join("/tmp", `${Date.now()}_${path.basename(filenameHint)}`);
  const resp = await axios.get(url, { responseType: "stream", timeout: 60_000 });
  await new Promise<void>((resolve, reject) => {
    const w = fs.createWriteStream(tmp);
    resp.data.pipe(w);
    w.on("finish", () => resolve());
    w.on("error", reject);
  });
  const file = await client.files.create({
    file: fs.createReadStream(tmp),
    purpose: "assistants",
  });
  return file.id;
}

// (Опционально) создать vector store и закинуть туда файлы для file_search
async function ensureVectorStoreFor(fileIds: string[]) {
  if (!fileIds.length) return { vsId: undefined as string | undefined };
  const vs = await client.vectorStores.create({ name: `vs_${Date.now()}` });
  // дождаться индексации
  await Promise.all(
    fileIds.map((fid) => client.vectorStores.files.createAndPoll(vs.id, { file_id: fid }))
  );
  return { vsId: vs.id };
}

/**
 * POST /run
 * Body JSON:
 * {
 *   "text": "Сделай отчет",
 *   "file_urls": ["https://api.telegram.org/file/bot<TOKEN>/<file_path>", "..."],
 *   "file_ids": ["file_abc123"] // если уже загружали в OpenAI ранее (через Make/ваш бэкенд)
 * }
 */
app.post("/run", async (req, res) => {
  try {
    const { text = "", file_urls = [], file_ids = [] } = req.body as {
      text?: string;
      file_urls?: string[];
      file_ids?: string[];
    };

    // 1) Скачиваем и загружаем все URL в OpenAI (получаем file_id)
    const uploadedIds: string[] = [];
    for (const url of file_urls) {
      const fid = await uploadToOpenAIFromUrl(url);
      uploadedIds.push(fid);
    }
    const allFileIds = [...file_ids, ...uploadedIds];

    // 2) (опционально) Индексируем для file_search
    const { vsId } = await ensureVectorStoreFor(allFileIds);

    // 3) Формируем корректный input для Runner.run
    const input: AgentInputItem[] = [
      { role: "user", content: [{ type: "input_text", text }] },
    ];

    // 4) attachments: важно указать инструменты, которые получат доступ к файлам
    const attachments =
      allFileIds.map((id) => ({
        file_id: id,
        tools: [{ type: "code_interpreter" }, { type: "file_search" }],
      })) ?? [];

    const fileIds: string[] = allFileIds; 
    const content = [
       { type: "input_text", text },
       ...allFileIds.map((id) => ({
          type: "input_file" as const,
          file_id: id,
          tools: [{ type: "code_interpreter" as const }, { type: "file_search" as const }],
          })),
     ];
    const agentInput: AgentInputItem[] = [{ role: "user", content }];
     const out = await runner.run(agent, agentInput);
    
    res.json(out);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err?.message ?? "run_failed" });
  }
});

app.get("/healthz", (_req, res) => res.send("ok"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Agent service listening on :${PORT}`));
