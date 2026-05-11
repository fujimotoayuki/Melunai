export interface ChatOnlyModel {
  name: string;
}

export async function fetchChatModels(): Promise<{ models: string[]; error: string | null }> {
  const result = await window.localFileAgent.fetchModels();
  if (!result.ok) {
    return { models: [], error: resolveModelError(result.error.code) };
  }
  return { models: result.data.map((model: ChatOnlyModel) => model.name), error: null };
}

export async function sendChatOnlyMessage(args: {
  userInstruction: string;
  model: string;
  sessionId?: string;
}): Promise<{ ok: true; message: string } | { ok: false; userMessage: string }> {
  const result = await window.localFileAgent.chatMessage({
    userInstruction: args.userInstruction,
    model: args.model,
    filePreviews: [],
    sessionId: args.sessionId,
  });

  if (!result.ok) {
    return { ok: false, userMessage: resolveChatError(result.error.code) };
  }

  return { ok: true, message: result.data };
}

export function streamChatOnlyMessage(
  args: {
    requestId: string;
    userInstruction: string;
    model: string;
    ollamaConfig?: {
      systemPrompt?: string;
      temperature?: number;
      contextWindow?: number;
    };
    useCorpus?: boolean;
    sessionId?: string;
  },
  onEvent: (event: import("../electron-api.js").ChatStreamEvent) => void,
): () => void {
  return window.localFileAgent.chatMessageStream(args, onEvent);
}

export type ChatConversationSummary = import("../electron-api.js").ChatConversationSummary;
export type ChatHistoryConversation = import("../electron-api.js").ChatHistoryConversation;
export type ChatHistoryMessage = import("../electron-api.js").ChatHistoryMessage;

export async function listChatHistory(): Promise<ChatConversationSummary[]> {
  try {
    const result = await window.localFileAgent.chatHistoryList();
    return result.ok ? result.data : [];
  } catch {
    return [];
  }
}

export async function createChatHistoryConversation(
  messages: ChatHistoryMessage[],
): Promise<ChatHistoryConversation | null> {
  try {
    const result = await window.localFileAgent.chatHistoryCreate({ messages });
    return result.ok ? result.data : null;
  } catch {
    return null;
  }
}

export async function loadChatHistoryConversation(
  id: string,
): Promise<ChatHistoryConversation | null> {
  try {
    const result = await window.localFileAgent.chatHistoryLoad(id);
    return result.ok ? result.data : null;
  } catch {
    return null;
  }
}

export async function saveChatHistoryConversation(
  id: string,
  messages: ChatHistoryMessage[],
  title?: string,
): Promise<ChatConversationSummary | null> {
  try {
    const result = await window.localFileAgent.chatHistorySave({ id, messages, title });
    return result.ok ? result.data : null;
  } catch {
    return null;
  }
}

export async function renameChatHistoryConversation(
  id: string,
  title: string,
): Promise<ChatConversationSummary | null> {
  try {
    const result = await window.localFileAgent.chatHistoryRename({ id, title });
    return result.ok ? result.data : null;
  } catch {
    return null;
  }
}

export async function deleteChatHistoryConversation(
  id: string,
): Promise<{ deleted: boolean; nextId: string | null } | null> {
  try {
    const result = await window.localFileAgent.chatHistoryDelete(id);
    return result.ok ? result.data : null;
  } catch {
    return null;
  }
}

function resolveModelError(code: string): string {
  switch (code) {
    case "ollama_unavailable":
      return "Ollamaに接続できませんでした。Ollamaが起動しているか確認してください。";
    case "ollama_timeout":
      return "Ollamaからの応答がタイムアウトしました。";
    case "ollama_invalid_response":
      return "Ollamaから予期しない形式の応答が返されました。";
    default:
      return "モデル一覧の取得に失敗しました。";
  }
}

function resolveChatError(code: string): string {
  switch (code) {
    case "ollama_unavailable":
      return "Ollamaに接続できません。Ollamaが起動しているか確認してください。";
    case "ollama_timeout":
      return "ローカルLLMの返答が遅れています。";
    case "ollama_model_not_found":
      return "選択中のモデルがOllamaに見つかりません。モデルを選び直してください。";
    default:
      return "会話の返答を作れませんでした。";
  }
}
