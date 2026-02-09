import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const response = await openai.responses.create({
  prompt: {
    "id": "pmpt_68ecba2f94b0819396c6f621781d60d60b58dc2d2b34cef4",
    "version": "6"
  },
  input: [],
  reasoning: {},
  tools: [
    {
      "type": "file_search",
      "vector_store_ids": [
        "vs_68f76e4a720481918197a0e124b859b8"
      ]
    },
    {
      "type": "web_search",
      "filters": {
        "allowed_domains": [
          "zakupki.gov.ru"
        ]
      },
      "search_context_size": "medium",
      "user_location": {
        "type": "approximate",
        "city": null,
        "country": null,
        "region": null,
        "timezone": null
      }
    },
    {
      "type": "code_interpreter",
      "container": {
        "type": "auto"
      }
    }
  ],
  store: true,
  include: [
    "code_interpreter_call.outputs",
    "reasoning.encrypted_content",
    "web_search_call.action.sources"
  ]
});
