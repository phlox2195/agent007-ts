import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default {
  async run({ input, conversation_id }: { input: any; conversation_id: string }) {
    const system = {
      role: 'system',
      content:
        'Ты — эксперт по справочно-правовой системе КонсультантПлюс. Помогаешь менеджерам по продажам анализировать потребности организаций.'
    };

    const messages = Array.isArray(input) ? [system, ...input] : [system, { role: 'user', content: String(input || '') }];

    const resp = await client.responses.create({
      model: 'gpt-5',
      input: messages,
      tools: [
        { type: 'web_search' },
        { type: 'code_interpreter' }
      ],
      metadata: { conversation_id }
    });

    const text =
      (resp as any).output_text ??
      (Array.isArray(resp.output) && resp.output.length
        ? resp.output[0].content?.[0]?.text || resp.output[0].content?.text || ''
        : '');

    return { output_text: text };
  }
};
