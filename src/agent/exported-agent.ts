import {
  Agent,
  fileSearchTool,
  webSearchTool,
} from "@openai/agents";

export default function agentFromEnv() {
  const vsId = process.env.VECTOR_STORE_ID;
  if (!vsId) throw new Error("VECTOR_STORE_ID is not set");

  return buildAgentWithVS(vsId);
}

export function buildAgentWithVS(vsId: string) {
  const fileSearch = fileSearchTool([vsId]);

  const webSearchPreview = webSearchTool({
    searchContextSize: "medium",
    userLocation: { type: "approximate" },
  });

  return new Agent({
    name: "agent007",
    model: "gpt-5",

    
    "prompt": {
    "id": "pmpt_68ecba2f94b0819396c6f621781d60d60b58dc2d2b34cef4",
    "version": "6"
  },

    tools: [fileSearch, webSearchPreview],

    modelSettings: {
      reasoning: { effort: "low" },
      store: true,
    },
  });
}
