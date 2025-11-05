import express from "express";
import fs from "fs";
import path from "path";
import axios from "axios";
import { OpenAI } from "openai";
import { Runner } from "@openai/agents";
import { buildAgentWithVS } from "./agent/exported-agent.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

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

async function uploadToOpenAIFromUrl(url: string, filenameHint = "file.md") {
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
    const uploadedIds: string[] = [];
    for (const url of fileUrls) {
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue; // защита от мусора
      const fid = await uploadToOpenAIFromUrl(url);
      uploadedIds.push(fid);
    }
    const allFileIds: string[] = [...openAiIds, ...uploadedIds];
    const vsId = await VS_ID_PROMISE;
    if (allFileIds.length) {
      await Promise.all(
        allFileIds.map(async (fid) => {
          try {
            await client.vectorStores.files.createAndPoll(vsId, { file_id: fid });
          } 
          catch (e: any) {
            const msg = String(e?.message ?? "");
            if (e?.status !== 409 && !/already exists/i.test(msg)) throw e;
          }
        })
      );
    }    
    type ContentItem = { type: "input_text"; text: string };
    const content: ContentItem[] = [
      { type: "input_text", text },
    ];
    const agent = buildAgentWithVS(vsId);
    const out = await runner.run(agent, [{ role: "user" as const, content }]);
    res.json(out);
  } 
  catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err?.message ?? "run_failed" });
  }
});

app.get("/", (_req, res) => {
  res.status(200).send("Agent007 API is running. Use POST /run");
});
app.get("/healthz", (_req, res) => res.send("ok"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Agent service listening on :${PORT}`));
