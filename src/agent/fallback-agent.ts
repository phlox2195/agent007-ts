import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default {
  async run({
    input,
    conversation_id
  }: {
    input: any;
    conversation_id: string;
  }) {
    const system = {
      role: "system",
      content:
        "Ты — эксперт по справочно-правовой системе КонсультантПлюс. Помогаешь менеджерам по продажам анализировать потребности организаций."
    };

    const messages = Array.isArray(input)
      ? [system, ...input]
      : [system, { role: "user", content: String(input || "") }];

    const resp = await client.responses.create({
      model: "gpt-5",
      input: messages as any,
      
      tools: [
        {
          type: "web_search_preview",
          searchContextSize: "medium",
          userLocation: { type: "approximate" }
        } as any,
        {
          type: "code_interpreter",
          container: { type: "auto", file_ids: [] }
        } as any
      ],
      metadata: { conversation_id }
    });

    
    const text =
      (resp as any).output_text ??
      "";

    return { output_text: text };
  }
};
