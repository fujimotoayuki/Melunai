import React from "react";

import { CanvasPanel } from "./components/CanvasPanel.js";
import type { CanvasMarkdownGenerateRequest } from "./components/CanvasPanel.js";
import { ChatPanel } from "./components/ChatPanel.js";
import { Corpus2SkillPanel } from "./components/Corpus2SkillPanel.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { McpSettingsPanel } from "./components/McpSettingsPanel.js";
import { openCanvas, saveCanvas, startCanvas, streamCanvasMarkdown } from "./bridge/canvasBridge.js";
import { getCorpusStatus } from "./bridge/corpusBridge.js";
import {
  deleteChatHistoryConversation,
  fetchChatModels,
  listChatHistory,
  loadChatHistoryConversation,
  renameChatHistoryConversation,
  saveChatHistoryConversation,
  streamChatOnlyMessage,
} from "./bridge/chatOnlyBridge.js";
import type { CanvasDocument, ChatConversationSummary, ChatHistoryMessage } from "./electron-api.js";
import type { AppPhase, ChatMessage } from "./state/appState.js";

interface ChatSettings {
  systemPrompt: string;
  temperature: number;
  contextWindow: number;
}

interface AppliedChatSettings {
  model: string;
  hasSystemPrompt: boolean;
  systemPromptChars: number;
  temperature: number | null;
  contextWindow: number | null;
  sentAt: string;
}

export function App(): React.ReactElement {
  const [messages, setMessages] = React.useState<ChatMessage[]>(() => defaultMessages());
  const [phase, setPhase] = React.useState<AppPhase>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [input, setInput] = React.useState("");
  const [conversations, setConversations] = React.useState<ChatConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = React.useState<string | null>(null);
  const [chatThreadKey, setChatThreadKey] = React.useState(() => newConversationId());
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [historyReady, setHistoryReady] = React.useState(false);
  const [editingTitleId, setEditingTitleId] = React.useState<string | null>(null);
  const [titleDraft, setTitleDraft] = React.useState("");
  const [models, setModels] = React.useState<string[]>([]);
  const [selectedModel, setSelectedModel] = React.useState("");
  const [modelError, setModelError] = React.useState<string | null>(null);
  const [loadingModels, setLoadingModels] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [chatSettings, setChatSettings] = React.useState<ChatSettings>(() => loadChatSettings());
  const [settingsDraft, setSettingsDraft] = React.useState<ChatSettings>(() => loadChatSettings());
  const [settingsSaveStatus, setSettingsSaveStatus] = React.useState<"saved" | "dirty">("saved");
  const [lastAppliedSettings, setLastAppliedSettings] = React.useState<AppliedChatSettings | null>(null);
  const [canvasDocument, setCanvasDocument] = React.useState<CanvasDocument | null>(null);
  const [canvasContent, setCanvasContent] = React.useState("");
  const [canvasDirty, setCanvasDirty] = React.useState(false);
  const [canvasSaving, setCanvasSaving] = React.useState(false);
  const [canvasError, setCanvasError] = React.useState<string | null>(null);
  const [canvasWidthPercent, setCanvasWidthPercent] = React.useState(50);
  const [canvasVisible, setCanvasVisible] = React.useState(false);
  const [canvasGenerating, setCanvasGenerating] = React.useState(false);
  const [mcpOpen, setMcpOpen] = React.useState(false);
  const [corpusOpen, setCorpusOpen] = React.useState(false);
  const [useCorpus, setUseCorpus] = React.useState(false);
  const [corpusReference, setCorpusReference] = React.useState<{
    workspaceRoot: string;
    label: string;
    indexedFileCount: number;
  } | null>(null);
  const [corpusContextSummary, setCorpusContextSummary] = React.useState<string | null>(null);
  const [assistantOpen, setAssistantOpen] = React.useState(false);
  const [resizing, setResizing] = React.useState(false);
  const shellRef = React.useRef<HTMLDivElement>(null);
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const chatAreaRef = React.useRef<HTMLElement>(null);
  const chatStreamCleanupRef = React.useRef<(() => void) | null>(null);
  const activeRequestIdRef = React.useRef<string | null>(null);
  const activeConversationIdRef = React.useRef<string | null>(null);
  const draftConversationIdRef = React.useRef<string>(newConversationId());
  const stoppedRequestIdsRef = React.useRef<Set<string>>(new Set());
  const historySaveTimerRef = React.useRef<number | null>(null);
  const suppressNextHistorySaveRef = React.useRef(false);
  // Click-outside refs for popovers
  const historyBtnRef = React.useRef<HTMLButtonElement>(null);
  const historyPanelRef = React.useRef<HTMLElement>(null);
  const settingsBtnRef = React.useRef<HTMLButtonElement>(null);
  const settingsPanelRef = React.useRef<HTMLDivElement>(null);
  // Canvas stream cleanup ref（chat と同じパターンで listener リーク防止）
  const canvasStreamCleanupRef = React.useRef<(() => void) | null>(null);
  // 同期判定用 ref（setState の非同期反映を待たずに連打/IME 二重発火を防ぐ）
  const phaseRef = React.useRef<AppPhase>("idle");
  React.useEffect(() => { phaseRef.current = phase; }, [phase]);
  const [shouldAutoScroll, setShouldAutoScroll] = React.useState(true);

  React.useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  React.useEffect(() => {
    void refreshModels();
    void initializeChatHistory();
    void syncCorpusStatus();
  }, []);

  React.useEffect(() => {
    if (!historyReady || phase !== "idle" || activeConversationId === null || !shouldPersistConversation(messages)) return;
    if (suppressNextHistorySaveRef.current) {
      suppressNextHistorySaveRef.current = false;
      return;
    }
    if (historySaveTimerRef.current !== null) {
      window.clearTimeout(historySaveTimerRef.current);
    }
    historySaveTimerRef.current = window.setTimeout(() => {
      void persistConversation(activeConversationId, messages)
        .then((summary) => {
          if (summary === null) return;
          setConversations((current) => upsertConversationSummary(current, summary));
        });
    }, 450);
  }, [activeConversationId, historyReady, messages, phase]);

  React.useEffect(() => {
    localStorage.setItem("melunai:chat-settings", JSON.stringify(chatSettings));
  }, [chatSettings]);

  React.useEffect(() => {
    if (!settingsOpen) return;
    setSettingsDraft(chatSettings);
    setSettingsSaveStatus("saved");
  }, [settingsOpen, chatSettings]);

  React.useEffect(() => {
    return () => {
      if (historySaveTimerRef.current !== null) {
        window.clearTimeout(historySaveTimerRef.current);
      }
      // unmount 時に進行中ストリームを必ず停止（HMR 等での暴走防止）
      if (chatStreamCleanupRef.current !== null) {
        try {
          chatStreamCleanupRef.current();
        } catch {
          // cleanup の例外は無視（unmount 時なので）
        }
        chatStreamCleanupRef.current = null;
      }
      if (canvasStreamCleanupRef.current !== null) {
        try {
          canvasStreamCleanupRef.current();
        } catch { /* ignore */ }
        canvasStreamCleanupRef.current = null;
      }
    };
  }, []);

  React.useEffect(() => {
    resizeComposer(inputRef.current);
  }, [input]);

  // Click-outside-to-close: settings popover
  React.useEffect(() => {
    if (!settingsOpen) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (settingsBtnRef.current?.contains(target)) return;
      if (settingsPanelRef.current?.contains(target)) return;
      setSettingsOpen(false);
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [settingsOpen]);

  // Click-outside-to-close: history panel
  React.useEffect(() => {
    if (!historyOpen) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (historyBtnRef.current?.contains(target)) return;
      if (historyPanelRef.current?.contains(target)) return;
      setHistoryOpen(false);
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [historyOpen]);

  React.useEffect(() => {
    // 依存配列を空にして、handler 内では ref 経由で最新 state を参照する。
    // 以前は依存配列が無く、毎レンダリングで listener が再登録されて
    // ストリーミング中に CPU が無駄に焼かれていた。
    const handleKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "n") {
        event.preventDefault();
        startNewChat();
        return;
      }
      if (mod && event.key.toLowerCase() === "l") {
        event.preventDefault();
        setAssistantOpen(true);
        window.setTimeout(() => inputRef.current?.focus(), 0);
        return;
      }
      if (mod && event.key === "Enter") {
        event.preventDefault();
        void submit();
        return;
      }
      if (event.key === "Escape" && phaseRef.current === "planning") {
        event.preventDefault();
        stopChatGeneration();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (!resizing) return;

    const handlePointerMove = (event: PointerEvent) => {
      if (shellRef.current === null) return;
      const rect = shellRef.current.getBoundingClientRect();
      const nextPercent = ((event.clientX - rect.left) / rect.width) * 100;
      setCanvasWidthPercent(clamp(nextPercent, 30, 70));
    };

    const handlePointerUp = () => {
      setResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [resizing]);

  const initializeChatHistory = async () => {
    const summaries = await listChatHistory();
    setConversations(summaries);

    if (summaries.length > 0) {
      const first = summaries[0];
      if (first !== undefined) {
        const conversation = await loadChatHistoryConversation(first.id);
        if (conversation !== null) {
          suppressNextHistorySaveRef.current = true;
          activeConversationIdRef.current = conversation.id;
          setChatThreadKey(conversation.id);
          setActiveConversationId(conversation.id);
          setMessages(conversation.messages as ChatMessage[]);
          setHistoryReady(true);
          return;
        }
      }
    }

    activeConversationIdRef.current = null;
    const draftId = newConversationId();
    draftConversationIdRef.current = draftId;
    setChatThreadKey(draftId);
    setActiveConversationId(null);
    setMessages(defaultMessages());
    setHistoryReady(true);
  };

  const syncCorpusStatus = async () => {
    const result = await getCorpusStatus();
    if (result.index === null) {
      setCorpusReference(null);
      setUseCorpus(false);
      setCorpusContextSummary(null);
      return;
    }
    handleCorpusReady(result.index);
  };

  const refreshModels = async () => {
    setLoadingModels(true);
    setModelError(null);
    const result = await fetchChatModels();
    setLoadingModels(false);
    setModels(result.models);
    setModelError(result.error);
    setSelectedModel((current) => current || result.models[0] || "");
  };

  const persistConversation = async (
    conversationId: string,
    nextMessages: ChatMessage[],
  ): Promise<ChatConversationSummary | null> => {
    if (!shouldPersistConversation(nextMessages)) return null;
    return saveChatHistoryConversation(conversationId, nextMessages as ChatHistoryMessage[]);
  };

  const saveChatSettingsDraft = () => {
    const nextSettings: ChatSettings = {
      systemPrompt: settingsDraft.systemPrompt.slice(0, MAX_SYSTEM_PROMPT_LENGTH),
      temperature: sanitizeTemperature(settingsDraft.temperature),
      contextWindow: sanitizeContextWindow(settingsDraft.contextWindow) ?? 4096,
    };
    setChatSettings(nextSettings);
    setSettingsDraft(nextSettings);
    setSettingsSaveStatus("saved");
  };

  const submit = async () => {
    // textarea から直接読むことで closure の stale 問題を回避（keydown ショートカット対策）
    const text = (inputRef.current?.value ?? input).trim();
    // phase は ref で同期判定し、IME 二重発火・autorepeat による多重送信を防ぐ
    if (text.length === 0 || phaseRef.current === "planning") return;
    startChatStream(text, {
      addUserMessage: true,
      clearInput: true,
    });
  };

  const startChatStream = (
    text: string,
    options: {
      addUserMessage: boolean;
      clearInput: boolean;
      assistantId?: string;
    },
  ) => {
    if (selectedModel.length === 0) {
      setError("Ollamaモデルが選択されていません。上部のモデル一覧を更新してください。");
      return;
    }
    if (useCorpus && corpusReference === null) {
      setError("資料フォルダが選択されていません。先に資料フォルダを読み込んでください。");
      setCorpusOpen(true);
      return;
    }

    // 前回のストリームが残っていれば必ず先に解除する。
    // これを忘れると IPC listener と main 側 AbortController がリークする。
    // 注意: stoppedRequestIdsRef.add は cleanup より「前」に行う必要がある。
    // 後にすると、cleanup() で listener を外した直後に main の done/error が届いた場合、
    // 自前 listener はもう外れているので誰にも処理されず（=実害なし）、
    // 一方で stoppedRequestIdsRef は単調増加してリークする。
    // 正しい順序: (1) 古い requestId を stoppedSet に登録 → (2) cleanup() で listener 解除。
    if (activeRequestIdRef.current !== null) {
      stoppedRequestIdsRef.current.add(activeRequestIdRef.current);
      activeRequestIdRef.current = null;
    }
    if (chatStreamCleanupRef.current !== null) {
      chatStreamCleanupRef.current();
      chatStreamCleanupRef.current = null;
    }

    if (options.clearInput) setInput("");
    setError(null);
    setCorpusContextSummary(null);
    setAssistantOpen(true);
    // phase ref を同期で先に書き換える。setPhase は次レンダーで反映されるため、
    // 同フレーム内で submit() を再度叩かれた時に phaseRef.current が古いままだと
    // 二重ストリーム起動になる（IME の二重発火、autorepeat、Cmd+Enter 連打など）。
    phaseRef.current = "planning";
    setPhase("planning");
    const assistantId = options.assistantId ?? nextMessageId();
    const requestId = `stream-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    activeRequestIdRef.current = requestId;
    const streamConversationId = activeConversationIdRef.current ?? draftConversationIdRef.current;
    if (options.addUserMessage && activeConversationIdRef.current === null) {
      activeConversationIdRef.current = streamConversationId;
      setActiveConversationId(streamConversationId);
    }

    setMessages((prev) => {
      const assistantMessage: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        timestamp: new Date().toISOString(),
      };
      if (options.assistantId !== undefined) {
        return prev.map((message) =>
          message.id === options.assistantId ? assistantMessage : message,
        );
      }
      return options.addUserMessage
        ? [...prev, makeMessage("user", text), assistantMessage]
        : [...prev, assistantMessage];
    });

    let cleanup: (() => void) | null = null;
    cleanup = streamChatOnlyMessage(
      {
        requestId,
        userInstruction: text,
        model: selectedModel,
        ollamaConfig: {
          systemPrompt: chatSettings.systemPrompt.trim() || undefined,
          temperature: chatSettings.temperature,
          contextWindow: chatSettings.contextWindow,
        },
        useCorpus,
        sessionId: streamConversationId,
      },
      (event) => {
        const wasStopped = stoppedRequestIdsRef.current.has(event.requestId);
        if (event.type === "context") {
          if (wasStopped) return;
          setCorpusContextSummary(event.summary);
          return;
        }
        if (event.type === "settings") {
          if (wasStopped) return;
          setLastAppliedSettings({
            model: event.model,
            hasSystemPrompt: event.hasSystemPrompt,
            systemPromptChars: event.systemPromptChars,
            temperature: event.temperature,
            contextWindow: event.contextWindow,
            sentAt: new Date().toISOString(),
          });
          return;
        }
        if (event.type === "delta") {
          if (wasStopped) return;
          setMessages((prev) => appendToMessage(prev, assistantId, event.delta));
          return;
        }

        if (event.type === "done") {
          if (wasStopped) {
            stoppedRequestIdsRef.current.delete(event.requestId);
            return;
          }
          // updater 内の副作用は React 18 StrictMode で 2 回実行され二重保存になるため、
          // 純粋な state 更新だけ行い、保存は messages 変更を観測する debounce useEffect に任せる。
          setMessages((prev) => replaceMessage(prev, assistantId, event.message, event.stats));
          setPhase("idle");
          chatStreamCleanupRef.current = null;
          activeRequestIdRef.current = null;
          cleanup?.();
          return;
        }

        if (wasStopped) {
          stoppedRequestIdsRef.current.delete(event.requestId);
          setMessages((prev) => ensureStoppedMessage(prev, assistantId));
          setPhase("idle");
          chatStreamCleanupRef.current = null;
          activeRequestIdRef.current = null;
          cleanup?.();
          return;
        }
        setPhase("idle");
        setError(resolveStreamError(event.code));
        chatStreamCleanupRef.current = null;
        activeRequestIdRef.current = null;
        cleanup?.();
      },
    );
    chatStreamCleanupRef.current = cleanup;
  };

  const startNewChat = () => {
    if (activeRequestIdRef.current !== null) {
      stoppedRequestIdsRef.current.add(activeRequestIdRef.current);
    }
    chatStreamCleanupRef.current?.();
    chatStreamCleanupRef.current = null;
    activeRequestIdRef.current = null;
    if (historySaveTimerRef.current !== null) {
      window.clearTimeout(historySaveTimerRef.current);
      historySaveTimerRef.current = null;
    }
    setHistoryOpen(false);

    const draftId = newConversationId();
    const nextMessages = [
      makeMessage("assistant", "新しいチャットです。普通に話しかけてください。"),
    ];
    activeConversationIdRef.current = null;
    draftConversationIdRef.current = draftId;
    setChatThreadKey(draftId);
    setActiveConversationId(null);
    setMessages(nextMessages);
    setShouldAutoScroll(true);
    setAssistantOpen(true);
    setError(null);
    setInput("");
    setUseCorpus(false);
    setCorpusContextSummary(null);
    setPhase("idle");
    window.requestAnimationFrame(() => {
      chatAreaRef.current?.scrollTo({ top: 0, behavior: "auto" });
    });
  };

  const openConversation = async (id: string) => {
    if (id === activeConversationId || phase === "planning") return;
    const conversation = await loadChatHistoryConversation(id);
    if (conversation === null) return;
    chatStreamCleanupRef.current?.();
    chatStreamCleanupRef.current = null;
    activeRequestIdRef.current = null;
    if (historySaveTimerRef.current !== null) {
      window.clearTimeout(historySaveTimerRef.current);
      historySaveTimerRef.current = null;
    }
    suppressNextHistorySaveRef.current = true;
    setHistoryOpen(false);
    activeConversationIdRef.current = conversation.id;
    setChatThreadKey(conversation.id);
    setActiveConversationId(conversation.id);
    setMessages(conversation.messages as ChatMessage[]);
    setShouldAutoScroll(true);
    setInput("");
    setError(null);
    setPhase("idle");
    window.requestAnimationFrame(() => {
      chatAreaRef.current?.scrollTo({ top: 0, behavior: "auto" });
    });
  };

  const deleteConversation = async (id: string) => {
    if (phase === "planning") return;
    const result = await deleteChatHistoryConversation(id);
    if (result === null) return;
    const nextSummaries = await listChatHistory();
    setConversations(nextSummaries);
    if (id !== activeConversationId) return;

    if (result.nextId !== null) {
      await openConversation(result.nextId);
      return;
    }
    startNewChat();
  };

  const beginRenameConversation = (conversation: ChatConversationSummary) => {
    setEditingTitleId(conversation.id);
    setTitleDraft(conversation.title);
  };

  const commitRenameConversation = async () => {
    if (editingTitleId === null) return;
    const nextTitle = titleDraft.trim();
    if (nextTitle.length === 0) {
      setEditingTitleId(null);
      setTitleDraft("");
      return;
    }
    const summary = await renameChatHistoryConversation(editingTitleId, nextTitle);
    if (summary !== null) {
      setConversations((current) => upsertConversationSummary(current, summary));
    }
    setEditingTitleId(null);
    setTitleDraft("");
  };

  const stopChatGeneration = () => {
    if (activeRequestIdRef.current !== null) {
      stoppedRequestIdsRef.current.add(activeRequestIdRef.current);
    }
    chatStreamCleanupRef.current?.();
    chatStreamCleanupRef.current = null;
    activeRequestIdRef.current = null;
    // 同期 ref を即座に更新して、停止直後の Cmd+Enter 連打が再生成を引き起こすのを防ぐ
    phaseRef.current = "idle";
    setPhase("idle");
  };

  /**
   * stoppedRequestIdsRef の Set サイズが過大化しないよう、定期的に古いエントリを掃除する。
   * 各エントリは「停止された requestId」で、main 側からのイベントが来ない限り残り続ける。
   * 200 件を超えたら古い 100 件を捨てる（Set の挿入順序は保たれる）。
   */
  React.useEffect(() => {
    const interval = window.setInterval(() => {
      const set = stoppedRequestIdsRef.current;
      if (set.size > 200) {
        const drop = set.size - 100;
        let i = 0;
        for (const id of set) {
          if (i++ >= drop) break;
          set.delete(id);
        }
      }
    }, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const regenerateAssistantMessage = (assistantMessageId: string) => {
    if (phase === "planning") return;
    const assistantIndex = messages.findIndex((message) => message.id === assistantMessageId);
    if (assistantIndex < 0) return;
    const previousUser = [...messages.slice(0, assistantIndex)].reverse().find((message) => message.role === "user");
    if (previousUser === undefined) return;
    setMessages((prev) =>
      prev.map((message) =>
        message.id === assistantMessageId
          ? { ...message, content: "", stats: undefined, timestamp: new Date().toISOString() }
          : message,
      ),
    );
    startChatStream(previousUser.content, {
      addUserMessage: false,
      clearInput: false,
      assistantId: assistantMessageId,
    });
  };

  const editUserMessage = (userMessageId: string) => {
    if (phase === "planning") return;
    const userIndex = messages.findIndex((message) => message.id === userMessageId && message.role === "user");
    if (userIndex < 0) return;
    setAssistantOpen(true);
    setInput(messages[userIndex]?.content ?? "");
    setMessages((prev) => prev.slice(0, userIndex));
    window.setTimeout(() => {
      inputRef.current?.focus();
      resizeComposer(inputRef.current);
    }, 0);
  };

  const updateAutoScroll = () => {
    const element = chatAreaRef.current;
    if (element === null) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    setShouldAutoScroll(distanceFromBottom < 80);
  };

  const handleStartCanvas = async () => {
    setCanvasError(null);
    const result = await startCanvas();
    if (result.error !== null || result.document === null) {
      setCanvasError(result.error);
      return;
    }
    setCanvasDocument(result.document);
    setCanvasContent(result.document.content);
    setCanvasDirty(false);
  };

  const handleOpenCanvas = async () => {
    setCanvasError(null);
    const result = await openCanvas();
    if (result.error !== null || result.document === null) {
      setCanvasError(result.error);
      return;
    }
    setCanvasDocument(result.document);
    setCanvasContent(result.document.content);
    setCanvasDirty(false);
  };

  const handleSaveCanvas = async () => {
    if (canvasDocument === null) return;
    setCanvasSaving(true);
    setCanvasError(null);
    const result = await saveCanvas({
      filePath: canvasDocument.filePath,
      content: canvasContent,
    });
    setCanvasSaving(false);
    if (result.error !== null || result.document === null) {
      setCanvasError(result.error);
      return;
    }
    setCanvasDocument(result.document);
    setCanvasContent(result.document.content);
    setCanvasDirty(false);
  };

  const handleGenerateCanvasMarkdown = (request: CanvasMarkdownGenerateRequest) => {
    if (canvasDocument === null || canvasGenerating) return;
    if (selectedModel.length === 0) {
      setCanvasError("Ollamaモデルが選択されていません。上部のモデル一覧を更新してください。");
      return;
    }

    const previousContent = canvasContent;
    if (request.mode === "selection" && request.targetMarkdown.trim().length === 0) {
      setCanvasError("先に修正したい範囲を選択してください。");
      return;
    }

    // 前回の Canvas ストリームが残っていれば必ず先に解除（IPC listener リーク防止）
    if (canvasStreamCleanupRef.current !== null) {
      canvasStreamCleanupRef.current();
      canvasStreamCleanupRef.current = null;
    }

    const requestId = `canvas-md-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let nextMarkdown = "";
    let cleanup: (() => void) | null = null;

    setCanvasError(null);
    setCanvasGenerating(true);
    setCanvasDirty(true);
    setCanvasContent(composeCanvasMarkdown(previousContent, request, ""));

    cleanup = streamCanvasMarkdown(
      {
        requestId,
        userInstruction: request.instruction,
        currentMarkdown: previousContent,
        targetMarkdown: request.targetMarkdown,
        editMode: request.mode,
        model: selectedModel,
      },
      (event) => {
        if (event.type === "delta") {
          nextMarkdown += event.delta;
          setCanvasContent(composeCanvasMarkdown(previousContent, request, nextMarkdown));
          return;
        }

        if (event.type === "done") {
          const finalMarkdown = event.markdown.trim();
          const generatedFragment = finalMarkdown.length > 0 ? finalMarkdown : nextMarkdown.trim();
          const generatedMarkdown = composeCanvasMarkdown(previousContent, request, generatedFragment);
          setCanvasContent(generatedMarkdown);
          setCanvasGenerating(false);
          setCanvasDirty(true);
          setCanvasSaving(true);
          void saveCanvas({
            filePath: canvasDocument.filePath,
            content: generatedMarkdown,
          }).then((result) => {
            setCanvasSaving(false);
            if (result.error !== null || result.document === null) {
              // 保存失敗時は dirty 維持で「未保存の生成結果がある」状態を残す。
              // 完全ロールバックすると「成功したように見えてファイルだけ古い」混乱を生むため、
              // ユーザーに明示的にエラーを見せて再保存を促すのが正しい UX。
              setCanvasError(result.error ?? "保存に失敗しました。再度保存してください。");
              setCanvasDirty(true);
              return;
            }
            setCanvasDocument(result.document);
            setCanvasContent(result.document.content);
            setCanvasDirty(false);
          });
          cleanup?.();
          if (canvasStreamCleanupRef.current === cleanup) {
            canvasStreamCleanupRef.current = null;
          }
          return;
        }

        setCanvasGenerating(false);
        setCanvasContent(previousContent);
        setCanvasDirty(false);
        setCanvasError(resolveCanvasGenerationError(event.code));
        cleanup?.();
        if (canvasStreamCleanupRef.current === cleanup) {
          canvasStreamCleanupRef.current = null;
        }
      },
    );
    canvasStreamCleanupRef.current = cleanup;
  };

  const handleCorpusReady = (index: import("./electron-api.js").CorpusIndex) => {
    setCorpusReference({
      workspaceRoot: index.workspaceRoot,
      label: basenameForDisplay(index.workspaceRoot),
      indexedFileCount: index.indexedFileCount,
    });
    setUseCorpus(true);
    setCorpusContextSummary(null);
  };

  const toggleCorpusReference = () => {
    if (corpusReference === null) {
      setCorpusOpen(true);
      setUseCorpus(false);
      return;
    }
    setUseCorpus((current) => !current);
  };

  return (
    <div ref={shellRef} className="ml-app" style={styles.shell}>
      <div className="ml-stage-backdrop" aria-hidden="true" />
      {canvasVisible ? (
        <>
          <div style={{ ...styles.canvasPane, width: `${canvasWidthPercent}%` }}>
            <ErrorBoundary>
            <CanvasPanel
              document={canvasDocument}
              content={canvasContent}
              dirty={canvasDirty}
              saving={canvasSaving}
              error={canvasError}
              onStart={() => void handleStartCanvas()}
              onOpen={() => void handleOpenCanvas()}
              onContentChange={(next) => {
                setCanvasContent(next);
                setCanvasDirty(true);
              }}
              onSave={() => void handleSaveCanvas()}
              onMinimize={() => setCanvasVisible(false)}
              generating={canvasGenerating}
              onGenerateMarkdown={handleGenerateCanvasMarkdown}
            />
            </ErrorBoundary>
          </div>

          <div
            role="separator"
            aria-label="CanvasとChatの幅を変更"
            aria-orientation="vertical"
            className={`ml-resizer${resizing ? " ml-resizer--dragging" : ""}`}
            style={{ width: 8 }}
            onPointerDown={(event) => {
              event.preventDefault();
              setResizing(true);
            }}
          />
        </>
      ) : null}
      {false && (
        <aside style={styles.canvasRail}>
          <button
            className="ml-btn-canvas-restore"
            style={styles.canvasRestoreButton}
            onClick={() => setCanvasVisible(true)}
            title="Canvasを表示"
            aria-label="Canvasを表示"
          >
            {/* Canvas restore icon */}
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.4"/>
              <line x1="6" y1="1.5" x2="6" y2="14.5" stroke="currentColor" strokeWidth="1.4"/>
              <rect x="7.5" y="3.5" width="5.5" height="9" rx="1" fill="currentColor" opacity="0.28"/>
            </svg>
          </button>
        </aside>
      )}

      <section
        style={{
          ...styles.chatPane,
          ...(canvasVisible ? styles.chatPaneSplit : null),
          width: canvasVisible ? `${100 - canvasWidthPercent}%` : "100%",
        }}
      >
        {/* ヘッダー */}
        <header style={{ ...styles.header, ...(canvasVisible ? styles.headerSplit : null) }}>
          <div style={{ ...styles.brandGroup, ...(canvasVisible ? styles.brandGroupSplit : null) }}>
            <div style={styles.brand}>Melunai</div>
            <div style={styles.brandSub}>Local LLM</div>
          </div>
          <div
            className={canvasVisible ? "ml-model-bar-split" : undefined}
            style={{ ...styles.modelBar, ...(canvasVisible ? styles.modelBarSplit : null) }}
          >
            <button
              ref={historyBtnRef}
              className={historyOpen ? "ml-btn-accent" : "ml-btn-glass"}
              style={{ ...styles.iconButton, ...(canvasVisible ? styles.iconButtonSplit : null) }}
              onClick={() => setHistoryOpen((open) => !open)}
              title="チャット履歴 (Cmd+H)"
              aria-label="チャット履歴"
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                <path d="M3 3.2h9M3 7.5h9M3 11.8h5.8" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round"/>
              </svg>
            </button>
            <select
              className="ml-select"
              style={{ ...styles.select, ...(canvasVisible ? styles.selectSplit : null) }}
              value={selectedModel}
              onChange={(event) => setSelectedModel(event.currentTarget.value)}
              disabled={loadingModels}
            >
              {models.length === 0 ? (
                <option value="">モデルなし</option>
              ) : (
                models.map((model) => (
                  <option key={model} value={model}>{model}</option>
                ))
              )}
            </select>
            <button
              className="ml-btn-glass"
              style={{ ...styles.iconButton, ...(canvasVisible ? styles.iconButtonSplit : null) }}
              onClick={() => void refreshModels()}
              title="Ollamaモデルを再取得"
              disabled={loadingModels}
            >
              {/* refresh icon */}
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M12.5 7A5.5 5.5 0 1 1 7 1.5c2.07 0 3.88 1.14 4.84 2.83" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                <path d="M12 1.5v3H9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            <button
              className="ml-btn-glass"
              style={{ ...styles.iconButton, ...(canvasVisible ? styles.iconButtonSplit : null) }}
              onClick={startNewChat}
              title="新しいチャット (Cmd+N)"
            >
              {/* plus icon */}
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                <path d="M6.5 1v11M1 6.5h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
              </svg>
            </button>
            <button
              className={canvasVisible ? "ml-btn-accent" : "ml-btn-glass"}
              style={{ ...styles.iconButton, ...(canvasVisible ? styles.iconButtonSplit : null) }}
              onClick={() => setCanvasVisible((visible) => !visible)}
              title="Canvas"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="1.8" y="2" width="12.4" height="12" rx="2.4" stroke="currentColor" strokeWidth="1.35"/>
                <path d="M5.8 2v12M8 5h3.6M8 8h2.7M8 11h3.2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/>
              </svg>
            </button>
            <button
              className="ml-btn-glass"
              style={{ ...styles.iconButton, ...(canvasVisible ? styles.iconButtonSplit : null) }}
              onClick={() => setMcpOpen(true)}
              title="MCP接続"
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                <path d="M5.2 4.2 3.8 2.8a2 2 0 0 0-2.8 2.8L2.4 7M9.8 10.8l1.4 1.4a2 2 0 0 0 2.8-2.8L12.6 8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round"/>
                <path d="M5.1 9.9 9.9 5.1" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round"/>
                <path d="M4.8 7.5h5.4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round"/>
              </svg>
            </button>
            <button
              className="ml-btn-glass"
              style={{ ...styles.iconButton, ...(canvasVisible ? styles.iconButtonSplit : null) }}
              onClick={() => setCorpusOpen(true)}
              title="Corpus2Skill"
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                <path d="M7.5 2.2v10.6M3.2 4.4h8.6M4.5 7.5h6M5.8 10.6h3.4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round"/>
                <path d="M2.4 2.2h10.2v10.6H2.4z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              </svg>
            </button>
            <button
              className={useCorpus ? "ml-btn-accent" : "ml-btn-glass"}
              style={{ ...styles.corpusToggleButton, ...(canvasVisible ? styles.corpusToggleButtonSplit : null) }}
              onClick={toggleCorpusReference}
              title={corpusReference === null ? "資料フォルダを選ぶ" : `${corpusReference.label} を参照`}
            >
              {useCorpus ? "資料ON" : "資料"}
            </button>
            <button
              ref={settingsBtnRef}
              className="ml-btn-glass"
              style={{ ...styles.iconButton, ...(canvasVisible ? styles.iconButtonSplit : null) }}
              onClick={() => setSettingsOpen((open) => !open)}
              title="モデル設定"
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                <circle cx="7.5" cy="7.5" r="2.2" stroke="currentColor" strokeWidth="1.4"/>
                <path d="M7.5 1.5v1.6M7.5 11.9v1.6M1.5 7.5h1.6M11.9 7.5h1.6M3.25 3.25l1.15 1.15M10.6 10.6l1.15 1.15M11.75 3.25 10.6 4.4M4.4 10.6l-1.15 1.15" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
          {settingsOpen && (
            <div ref={settingsPanelRef} style={styles.settingsPopover}>
              <div style={styles.settingsStatus}>
                <span>{settingsSaveStatus === "dirty" ? "未保存の変更があります" : "設定は保存済み"}</span>
                <span>保存後、次の送信から反映</span>
              </div>
              <div style={styles.settingsApplied}>
                {lastAppliedSettings === null ? (
                  <span>Ollamaへ送った設定: まだ送信なし</span>
                ) : (
                  <>
                    <span>最後にOllamaへ送った設定</span>
                    <span>model: {lastAppliedSettings.model}</span>
                    <span>
                      system prompt: {lastAppliedSettings.hasSystemPrompt ? `${lastAppliedSettings.systemPromptChars}文字` : "なし"}
                    </span>
                    <span>
                      temperature: {lastAppliedSettings.temperature === null ? "未指定" : lastAppliedSettings.temperature.toFixed(1)}
                      {" / "}
                      context: {lastAppliedSettings.contextWindow === null ? "未指定" : lastAppliedSettings.contextWindow}
                    </span>
                  </>
                )}
              </div>
              <label style={styles.settingsLabel}>
                System prompt
                <textarea
                  style={styles.settingsTextarea}
                  value={settingsDraft.systemPrompt}
                  maxLength={MAX_SYSTEM_PROMPT_LENGTH}
                  onChange={(event) => {
                    const next = event.currentTarget.value.slice(0, MAX_SYSTEM_PROMPT_LENGTH);
                    setSettingsDraft((current) => ({ ...current, systemPrompt: next }));
                    setSettingsSaveStatus("dirty");
                  }}
                  placeholder="例: 日本語で簡潔に回答して..."
                />
              </label>
              <label style={styles.settingsLabel}>
                temperature: {settingsDraft.temperature.toFixed(1)}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.1}
                  value={settingsDraft.temperature}
                  onChange={(event) => {
                    const nextTemperature = sanitizeTemperature(event.currentTarget.value);
                    setSettingsDraft((current) => ({ ...current, temperature: nextTemperature }));
                    setSettingsSaveStatus("dirty");
                  }}
                />
              </label>
              <label style={styles.settingsLabel}>
                context window
                <input
                  style={styles.settingsInput}
                  type="number"
                  min={1024}
                  step={1024}
                  value={settingsDraft.contextWindow}
                  onChange={(event) => {
                    const nextContextWindow = sanitizeContextWindow(event.currentTarget.value);
                    setSettingsDraft((current) => ({ ...current, contextWindow: nextContextWindow ?? current.contextWindow }));
                    setSettingsSaveStatus("dirty");
                  }}
                />
              </label>
              <button
                className="ml-btn-accent"
                style={styles.settingsSaveButton}
                type="button"
                onClick={saveChatSettingsDraft}
                disabled={settingsSaveStatus === "saved"}
              >
                設定を保存
              </button>
            </div>
          )}
        </header>

        {historyOpen && (
          <aside ref={historyPanelRef} style={styles.historyPanel} aria-label="チャット履歴">
            <div style={styles.historyHeader}>
              <div>
                <div style={styles.historyKicker}>History</div>
                <div style={styles.historyTitle}>チャット履歴</div>
              </div>
              <button
                className="ml-btn-accent"
                style={styles.historyNewButton}
                onClick={startNewChat}
              >
                新規
              </button>
            </div>
            <div style={styles.historyList}>
              {!historyReady ? (
                <div style={styles.historyEmpty}>読み込み中...</div>
              ) : conversations.length === 0 ? (
                <div style={styles.historyEmpty}>履歴はまだありません。</div>
              ) : (
                conversations.map((conversation) => (
                  <div
                    key={conversation.id}
                    className="ml-history-item"
                    role="button"
                    tabIndex={0}
                    style={{
                      ...styles.historyItem,
                      ...(conversation.id === activeConversationId ? styles.historyItemActive : null),
                    }}
                    onClick={() => void openConversation(conversation.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void openConversation(conversation.id);
                      }
                    }}
                  >
                    <span style={styles.historyItemText}>
                      {editingTitleId === conversation.id ? (
                        <input
                          className="ml-history-title-input"
                          style={styles.historyTitleInput}
                          value={titleDraft}
                          autoFocus
                          onChange={(event) => setTitleDraft(event.currentTarget.value)}
                          onClick={(event) => event.stopPropagation()}
                          onBlur={() => void commitRenameConversation()}
                          onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void commitRenameConversation();
                            }
                            if (event.key === "Escape") {
                              setEditingTitleId(null);
                              setTitleDraft("");
                            }
                          }}
                        />
                      ) : (
                        <span
                          style={styles.historyItemTitle}
                          title="ダブルクリックでタイトル編集"
                          onDoubleClick={(event) => {
                            event.stopPropagation();
                            beginRenameConversation(conversation);
                          }}
                        >
                          {conversation.title}
                        </span>
                      )}
                      <span style={styles.historyItemPreview}>
                        {conversation.preview || `${conversation.messageCount}件のメッセージ`}
                      </span>
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      style={styles.historyRename}
                      title="名前を変更"
                      aria-label="名前を変更"
                      onClick={(event) => {
                        event.stopPropagation();
                        beginRenameConversation(conversation);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          event.stopPropagation();
                          beginRenameConversation(conversation);
                        }
                      }}
                    >
                      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                        <path d="M8.8 1.7a1.7 1.7 0 0 1 1.5 1.5L3.5 10 1 11l1-2.5 6.8-6.8z" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      style={styles.historyDelete}
                      title="削除"
                      aria-label="削除"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (!window.confirm(`「${conversation.title}」を削除しますか？`)) return;
                        void deleteConversation(conversation.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          event.stopPropagation();
                          if (!window.confirm(`「${conversation.title}」を削除しますか？`)) return;
                          void deleteConversation(conversation.id);
                        }
                      }}
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                        <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                      </svg>
                    </span>
                  </div>
                ))
              )}
            </div>
          </aside>
        )}

        {modelError !== null && (
          <div className="ml-model-error" style={styles.modelError}>{modelError}</div>
        )}
        {useCorpus && (
          <div style={styles.corpusStatus}>
            <span style={styles.corpusStatusDot} />
            {corpusReference === null
              ? "資料フォルダ未選択"
              : corpusContextSummary === null
                ? `参照中: ${corpusReference.label} (${corpusReference.indexedFileCount}件)`
                : `参照中: ${corpusReference.label} / ${corpusContextSummary}`}
          </div>
        )}

        {/* チャットエリア */}
        <div style={styles.contextShelf}>
          <span style={styles.contextChip}>Local</span>
          {selectedModel.length > 0 && <span style={styles.contextChip}>{selectedModel}</span>}
          {useCorpus && corpusReference !== null && (
            <span style={styles.contextChipAccent}>参照中: {corpusReference.label}</span>
          )}
          {canvasVisible && <span style={styles.contextChipAccent}>Canvas</span>}
        </div>

        <main
          key={chatThreadKey}
          ref={chatAreaRef}
          style={styles.assistantPanel}
          onScroll={updateAutoScroll}
        >
          {messages.length <= 1 && (
            <section className="ml-hero" style={styles.hero}>
              <div className="ml-hero-eyebrow">Melunai</div>
              <h1
                className="ml-hero-title"
                style={{ fontSize: "clamp(30px, 4.2vw, 64px)" }}
              >
                ローカルAIを、<br />あなたの作業空間に。
              </h1>
              <div style={styles.heroSubline}>
                右下のチャットボタンから入力を開き、会話はこの画面でそのまま続きます。
              </div>
            </section>
          )}
          <ChatPanel
            key={chatThreadKey}
            messages={messages}
            phase={phase}
            planningError={error}
            bottomRef={bottomRef}
            shouldAutoScroll={shouldAutoScroll}
            onRegenerate={regenerateAssistantMessage}
            onEditUserMessage={editUserMessage}
          />
        </main>

        {/* 入力欄 */}
        {assistantOpen ? (
          <form
            className="ml-composer"
            style={styles.composerWrap}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <button
              className="ml-btn-glass"
              style={styles.composerMinimizeButton}
              type="button"
              onClick={() => setAssistantOpen(false)}
              title="入力欄を最小化"
              aria-label="入力欄を最小化"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <textarea
              ref={inputRef}
              className="ml-composer-input"
              style={styles.input}
              value={input}
              placeholder="Melunaiに話しかける..."
              rows={1}
              onChange={(event) => {
                setInput(event.currentTarget.value);
                resizeComposer(event.currentTarget);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              disabled={phase === "planning"}
            />
            <button
              className="ml-btn-send"
              style={{
                ...styles.sendButton,
                opacity: input.trim().length === 0 && phase !== "planning" ? undefined : 1,
              }}
              type={phase === "planning" ? "button" : "submit"}
              disabled={input.trim().length === 0 && phase !== "planning"}
              title={phase === "planning" ? "生成停止" : "送信"}
              onClick={(event) => {
                if (phase === "planning") {
                  event.preventDefault();
                  stopChatGeneration();
                }
              }}
            >
              {phase === "planning" ? (
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <rect x="5" y="5" width="8" height="8" rx="1.5" fill="currentColor" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <path d="M9 14.5V3.5M4 8.5l5-5 5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </button>
          </form>
        ) : (
          <button
            className="ml-btn-accent"
            style={styles.assistantLauncher}
            onClick={() => {
              setAssistantOpen(true);
              window.setTimeout(() => inputRef.current?.focus(), 0);
            }}
            title="チャットを開く"
            aria-label="チャットを開く"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M3.2 4.4A3.2 3.2 0 0 1 6.4 1.2h5.2a3.2 3.2 0 0 1 3.2 3.2v3.8a3.2 3.2 0 0 1-3.2 3.2H8.2l-3.9 3.2v-3.2A3.2 3.2 0 0 1 1.2 8.2V4.4Z" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round"/>
              <path d="M5.3 5.8h7.1M5.3 8.4h4.8" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round"/>
            </svg>
            <span>チャット</span>
          </button>
        )}
      </section>

      {mcpOpen && (
        <ErrorBoundary>
          <McpSettingsPanel onClose={() => setMcpOpen(false)} />
        </ErrorBoundary>
      )}
      {corpusOpen && (
        <ErrorBoundary>
          <Corpus2SkillPanel
            onClose={() => setCorpusOpen(false)}
            onCorpusReady={handleCorpusReady}
          />
        </ErrorBoundary>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

let messageCounter = 0;

function nextMessageId(): string {
  messageCounter += 1;
  return `msg-${messageCounter}`;
}

function makeMessage(role: ChatMessage["role"], content: string): ChatMessage {
  return {
    id: nextMessageId(),
    role,
    content,
    timestamp: new Date().toISOString(),
  };
}

function defaultMessages(): ChatMessage[] {
  return [
    makeMessage("assistant", "こんにちは。Melunaiは今、ローカルLLMと会話するだけの最小モードです。"),
  ];
}

function shouldPersistConversation(messages: ChatMessage[]): boolean {
  return messages.some((message) => message.role === "user" && message.content.trim().length > 0);
}

function newConversationId(): string {
  return `chat-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function basenameForDisplay(fullPath: string): string {
  const normalized = fullPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || fullPath;
}

function upsertConversationSummary(
  summaries: ChatConversationSummary[],
  next: ChatConversationSummary,
): ChatConversationSummary[] {
  const withoutCurrent = summaries.filter((summary) => summary.id !== next.id);
  return [next, ...withoutCurrent].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// 永続的プロンプトインジェクションを防ぐため systemPrompt 長さに上限を設ける（8KB）
const MAX_SYSTEM_PROMPT_LENGTH = 8192;
const MAX_CONTEXT_WINDOW = 131_072; // 一般的な上限。極端な値を防ぐため。

function loadChatSettings(): ChatSettings {
  try {
    const raw = localStorage.getItem("melunai:chat-settings");
    if (raw === null) return defaultChatSettings();
      const parsed = JSON.parse(raw) as Partial<ChatSettings>;
      return {
        systemPrompt:
          typeof parsed.systemPrompt === "string"
            ? parsed.systemPrompt.slice(0, MAX_SYSTEM_PROMPT_LENGTH)
            : "",
        temperature: sanitizeTemperature(parsed.temperature),
        contextWindow: sanitizeContextWindow(parsed.contextWindow) ?? 4096,
    };
  } catch {
    return defaultChatSettings();
  }
}

function defaultChatSettings(): ChatSettings {
  return {
    systemPrompt: "",
    temperature: 0.2,
    contextWindow: 4096,
  };
}

function sanitizeTemperature(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0.2;
  return Math.round(clamp(numeric, 0, 1) * 10) / 10;
}

function sanitizeContextWindow(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(clamp(numeric, 1024, MAX_CONTEXT_WINDOW));
}

function resizeComposer(textarea: HTMLTextAreaElement | null): void {
  if (textarea === null) return;
  textarea.style.height = "auto";
  const lineHeight = 24;
  const maxHeight = lineHeight * 8;
  textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
}

/** 1メッセージあたりの content 上限（256KB）。LLMが暴走出力した場合の保護。 */
const MAX_MESSAGE_CONTENT_CHARS = 256 * 1024;

function appendToMessage(messages: ChatMessage[], id: string, delta: string): ChatMessage[] {
  return messages.map((message) => {
    if (message.id !== id) return message;
    const next = message.content + delta;
    // 上限到達後は静かに切り詰める（UI が固まる前に保護）
    return {
      ...message,
      content: next.length > MAX_MESSAGE_CONTENT_CHARS ? next.slice(0, MAX_MESSAGE_CONTENT_CHARS) : next,
    };
  });
}

function replaceMessage(
  messages: ChatMessage[],
  id: string,
  content: string,
  stats?: ChatMessage["stats"],
): ChatMessage[] {
  return messages.map((message) =>
    message.id === id ? { ...message, content, stats } : message,
  );
}

function ensureStoppedMessage(messages: ChatMessage[], id: string): ChatMessage[] {
  return messages.map((message) =>
    message.id === id && message.content.trim().length === 0
      ? { ...message, content: "（生成を停止しました）" }
      : message,
  );
}

function resolveStreamError(code: string): string {
  switch (code) {
    case "ollama_unavailable":
      return "Ollamaに接続できません。Ollamaが起動しているか確認してください。";
    case "ollama_timeout":
      return "ローカルLLMの返答が遅れています。";
    case "ollama_model_not_found":
      return "選択中のモデルがOllamaに見つかりません。モデルを選び直してください。";
    case "no_corpus_workspace":
      return "資料フォルダが選択されていません。先に資料フォルダを読み込んでください。";
    case "corpus_missing":
      return "資料フォルダの読み込み情報が見つかりません。もう一度資料フォルダを読み込んでください。";
    case "corpus_empty":
      return "参照中の資料フォルダに読み込める文書がありません。";
    default:
      return "会話の返答を作れませんでした。";
  }
}

function resolveCanvasGenerationError(code: string): string {
  switch (code) {
    case "empty_instruction":
      return "MDに書く内容を入力してください。";
    case "ollama_unavailable":
      return "Ollamaに接続できません。Ollamaが起動しているか確認してください。";
    case "ollama_timeout":
      return "MD生成がタイムアウトしました。指示を短くするか、本文を少し減らして試してください。";
    case "ollama_model_not_found":
      return "選択中のモデルがOllamaに見つかりません。モデルを選び直してください。";
    default:
      return "MD生成に失敗しました。";
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function composeCanvasMarkdown(
  currentMarkdown: string,
  request: CanvasMarkdownGenerateRequest,
  generatedMarkdown: string,
): string {
  const current = normalizeMarkdown(currentMarkdown);
  const generated = normalizeMarkdown(generatedMarkdown).trim();
  if (generated.length === 0) return current;

  if (request.mode === "append") {
    if (request.insertAfterLine !== null) {
      const lines = current.split("\n");
      const insertIndex = clamp(Math.floor(request.insertAfterLine) + 1, 0, lines.length);
      const nextLines = [
        ...lines.slice(0, insertIndex),
        "",
        ...generated.split("\n"),
        ...lines.slice(insertIndex),
      ];
      return nextLines.join("\n").replace(/\n{3,}/g, "\n\n");
    }
    return current.trim().length === 0 ? generated : `${current.replace(/\s+$/, "")}\n\n${generated}`;
  }

  if (request.targetStartLine !== null && request.targetEndLine !== null) {
    const lines = current.split("\n");
    const nextLines = [
      ...lines.slice(0, request.targetStartLine),
      ...generated.split("\n"),
      ...lines.slice(request.targetEndLine + 1),
    ];
    return nextLines.join("\n");
  }

  if (request.targetMarkdown.length > 0 && current.includes(request.targetMarkdown)) {
    return current.replace(request.targetMarkdown, generated);
  }

  return current.trim().length === 0 ? generated : `${current.replace(/\s+$/, "")}\n\n${generated}`;
}

function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = {
  shell: {
    minHeight: "100vh",
    background:
      "linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0) 24%), linear-gradient(135deg, rgba(213,242,234,0.055) 0%, rgba(29,29,31,0) 32%, rgba(110,152,188,0.06) 100%), #1D1D1F",
    color: "#F5F5F7",
    display: "flex",
    flexDirection: "row",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif',
    overflow: "hidden",
  } as React.CSSProperties,

  canvasPane: {
    minWidth: 320,
    height: "100vh",
    flexShrink: 0,
    position: "relative",
    zIndex: 2,
  } as React.CSSProperties,

  canvasRail: {
    width: 52,
    height: "100vh",
    flexShrink: 0,
    display: "flex",
    justifyContent: "center",
    paddingTop: 14,
    borderRight: "1px solid rgba(255,255,255,0.07)",
    background: "rgba(29,29,31,0.95)",
  } as React.CSSProperties,

  canvasRestoreButton: {
    width: 32,
    height: 32,
    fontSize: 16,
    fontWeight: 800,
  } as React.CSSProperties,

  chatPane: {
    position: "relative",
    zIndex: 1,
    minWidth: 0,
    height: "100vh",
    display: "flex",
    flexDirection: "column",
    background:
      "linear-gradient(180deg, rgba(255,255,255,0.018), rgba(255,255,255,0) 28%), transparent",
    flexShrink: 0,
    overflowX: "hidden",
    overflowY: "visible",
    padding: "14px 18px 0",
  } as React.CSSProperties,

  chatPaneSplit: {
    padding: "14px 12px 0",
  } as React.CSSProperties,

  header: {
    position: "relative",
    height: 58,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 16px 0 20px",
    borderRadius: 24,
    border: "1px solid rgba(255,255,255,0.09)",
    background:
      "linear-gradient(180deg, rgba(255,255,255,0.086), rgba(255,255,255,0.038)), rgba(20,20,22,0.66)",
    backdropFilter: "saturate(180%) blur(30px)",
    WebkitBackdropFilter: "saturate(180%) blur(30px)",
    boxShadow: "0 18px 70px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.08)",
    zIndex: 5,
  } as React.CSSProperties,

  headerSplit: {
    height: 52,
    padding: "0 10px 0 14px",
    borderRadius: 22,
    gap: 8,
  } as React.CSSProperties,

  brandGroup: {
    display: "flex",
    flexDirection: "column",
    gap: 1,
    minWidth: 116,
  } as React.CSSProperties,

  brandGroupSplit: {
    minWidth: 84,
  } as React.CSSProperties,

  brand: {
    fontSize: 16,
    fontWeight: 800,
    color: "#F5F5F7",
    letterSpacing: 0,
  } as React.CSSProperties,

  brandSub: {
    fontSize: 10,
    color: "#7D7D86",
    letterSpacing: "0.06em",
    textTransform: "uppercase" as const,
    fontWeight: 500,
  } as React.CSSProperties,

  modelBar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: 4,
    borderRadius: 999,
    background: "rgba(255,255,255,0.035)",
    border: "1px solid rgba(255,255,255,0.045)",
  } as React.CSSProperties,

  modelBarSplit: {
    flex: "1 1 auto",
    minWidth: 0,
    maxWidth: "100%",
    gap: 5,
    padding: 3,
    overflowX: "auto",
    overflowY: "hidden",
    scrollbarWidth: "none",
    msOverflowStyle: "none",
    justifyContent: "flex-start",
  } as React.CSSProperties,

  select: {
    height: 32,
    maxWidth: 200,
    padding: "0 14px",
    fontSize: 12,
  } as React.CSSProperties,

  selectSplit: {
    width: 116,
    maxWidth: 116,
    height: 30,
    padding: "0 10px",
  } as React.CSSProperties,

  iconButton: {
    width: 32,
    height: 32,
    fontSize: 14,
  } as React.CSSProperties,

  iconButtonSplit: {
    width: 30,
    height: 30,
    flexShrink: 0,
  } as React.CSSProperties,

  corpusToggleButton: {
    height: 32,
    minWidth: 72,
    padding: "0 12px",
    fontSize: 12,
    fontWeight: 900,
  } as React.CSSProperties,

  corpusToggleButtonSplit: {
    height: 30,
    minWidth: 76,
    padding: "0 10px",
  } as React.CSSProperties,

  settingsPopover: {
    position: "absolute",
    top: 48,
    right: 28,
    width: 320,
    display: "flex",
    flexDirection: "column",
    gap: 12,
    padding: 14,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(29,29,31,0.96)",
    boxShadow: "0 24px 80px rgba(0,0,0,0.44)",
    zIndex: 20,
  } as React.CSSProperties,

  settingsLabel: {
    display: "flex",
    flexDirection: "column",
    gap: 7,
    color: "#A1A1A6",
    fontSize: 12,
  } as React.CSSProperties,

  settingsStatus: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid rgba(155,207,204,0.16)",
    background: "rgba(155,207,204,0.07)",
    color: "#D5F2EA",
    fontSize: 11,
    lineHeight: 1.45,
    fontWeight: 700,
  } as React.CSSProperties,

  settingsApplied: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.045)",
    color: "#A1A1A6",
    fontSize: 11,
    lineHeight: 1.45,
  } as React.CSSProperties,

  settingsTextarea: {
    minHeight: 88,
    resize: "vertical",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)",
    color: "#F5F5F7",
    outline: "none",
    padding: 10,
    fontSize: 13,
    lineHeight: 1.5,
  } as React.CSSProperties,

  settingsInput: {
    height: 32,
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)",
    color: "#F5F5F7",
    outline: "none",
    padding: "0 12px",
  } as React.CSSProperties,

  settingsSaveButton: {
    height: 34,
    alignSelf: "flex-end",
    padding: "0 14px",
    fontSize: 12,
    fontWeight: 900,
  } as React.CSSProperties,

  historyPanel: {
    position: "absolute",
    top: 88,
    left: 18,
    width: 286,
    maxHeight: "calc(100vh - 124px)",
    zIndex: 14,
    display: "flex",
    flexDirection: "column",
    gap: 12,
    padding: 14,
    borderRadius: 24,
    border: "1px solid rgba(255,255,255,0.1)",
    background:
      "linear-gradient(180deg, rgba(255,255,255,0.092), rgba(255,255,255,0.038)), rgba(20,20,22,0.84)",
    backdropFilter: "saturate(180%) blur(30px)",
    WebkitBackdropFilter: "saturate(180%) blur(30px)",
    boxShadow: "0 26px 90px rgba(0,0,0,0.46), inset 0 1px 0 rgba(255,255,255,0.08)",
    animation: "ml-slide-up 260ms cubic-bezier(0.16, 1, 0.3, 1) both",
  } as React.CSSProperties,

  historyHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  } as React.CSSProperties,

  historyKicker: {
    color: "#7D7D86",
    fontSize: 10,
    fontWeight: 900,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
  } as React.CSSProperties,

  historyTitle: {
    marginTop: 2,
    color: "#F5F5F7",
    fontSize: 15,
    fontWeight: 900,
  } as React.CSSProperties,

  historyNewButton: {
    height: 32,
    padding: "0 13px",
    fontSize: 12,
  } as React.CSSProperties,

  historyList: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    overflowY: "auto",
    paddingRight: 2,
  } as React.CSSProperties,

  historyItem: {
    width: "100%",
    minHeight: 62,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    padding: "10px 10px 10px 12px",
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.055)",
    background: "rgba(255,255,255,0.035)",
    color: "#F5F5F7",
    cursor: "pointer",
    textAlign: "left",
  } as React.CSSProperties,

  historyItemActive: {
    border: "1px solid rgba(155,207,204,0.28)",
    background: "linear-gradient(135deg, rgba(213,242,234,0.13), rgba(110,152,188,0.09))",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
  } as React.CSSProperties,

  historyItemText: {
    minWidth: 0,
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: 4,
  } as React.CSSProperties,

  historyItemTitle: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "#F5F5F7",
    fontSize: 13,
    fontWeight: 800,
  } as React.CSSProperties,

  historyItemPreview: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "#8F8F98",
    fontSize: 11,
    lineHeight: 1.35,
  } as React.CSSProperties,

  historyDelete: {
    width: 24,
    height: 24,
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    color: "#7D7D86",
    fontSize: 18,
    lineHeight: 1,
  } as React.CSSProperties,

  historyRename: {
    width: 24,
    height: 24,
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    color: "#7D7D86",
    fontSize: 11,
    fontWeight: 900,
    lineHeight: 1,
  } as React.CSSProperties,

  historyTitleInput: {
    width: "100%",
    height: 24,
    border: "1px solid rgba(155,207,204,0.32)",
    borderRadius: 9,
    background: "rgba(255,255,255,0.08)",
    color: "#F5F5F7",
    outline: "none",
    padding: "0 8px",
    fontSize: 13,
    fontWeight: 800,
    fontFamily: "inherit",
  } as React.CSSProperties,

  historyEmpty: {
    padding: "18px 10px 12px",
    color: "#8F8F98",
    fontSize: 12,
    lineHeight: 1.5,
  } as React.CSSProperties,

  modelError: {
    margin: "10px 20px 0",
    padding: "10px 14px",
    borderRadius: 10,
    color: "#ffb199",
    background: "rgba(255,120,90,0.09)",
    border: "1px solid rgba(255,120,90,0.16)",
    fontSize: 13,
    lineHeight: 1.5,
  } as React.CSSProperties,

  corpusStatus: {
    margin: "10px auto 0",
    width: "min(540px, calc(100% - 40px))",
    display: "flex",
    alignItems: "center",
    gap: 8,
    color: "#A1A1A6",
    fontSize: 12,
    fontWeight: 700,
  } as React.CSSProperties,

  corpusStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    background: "#9BCFCC",
    boxShadow: "0 0 12px rgba(155,207,204,0.65)",
    flexShrink: 0,
  } as React.CSSProperties,

  contextShelf: {
    position: "relative",
    zIndex: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap",
    gap: 8,
    width: "min(620px, calc(100% - 28px))",
    margin: "10px auto 0",
    pointerEvents: "none",
  } as React.CSSProperties,

  contextChip: {
    display: "inline-flex",
    alignItems: "center",
    maxWidth: 180,
    height: 26,
    padding: "0 10px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.09)",
    background: "rgba(255,255,255,0.052)",
    color: "#8F8F98",
    fontSize: 11,
    fontWeight: 800,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as React.CSSProperties,

  contextChipAccent: {
    display: "inline-flex",
    alignItems: "center",
    maxWidth: 220,
    height: 26,
    padding: "0 10px",
    borderRadius: 999,
    background: "linear-gradient(135deg, rgba(213,242,234,0.92), rgba(110,152,188,0.92))",
    color: "#1D1D1F",
    fontSize: 11,
    fontWeight: 900,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as React.CSSProperties,

  chatArea: {
    flex: 1,
    width: "min(540px, calc(100% - 40px))",
    margin: "0 auto",
    padding: "32px 0 144px",
    display: "flex",
    flexDirection: "column",
    gap: 22,
    overflowY: "auto",
  } as React.CSSProperties,

  quietStage: {
    flex: 1,
    width: "100%",
    minHeight: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "72px 24px 150px",
    overflow: "hidden",
  } as React.CSSProperties,

  assistantPanel: {
    flex: 1,
    minHeight: 0,
    margin: "0 auto",
    width: "min(820px, calc(100% - 40px))",
    display: "flex",
    flexDirection: "column",
    gap: 22,
    overflowY: "auto",
    padding: "30px 10px 30px",
    borderRadius: 0,
    border: "none",
    background: "transparent",
    boxShadow: "none",
    animation: "ml-slide-up 320ms cubic-bezier(0.16, 1, 0.3, 1) both",
  } as React.CSSProperties,

  assistantHeader: {
    position: "sticky",
    top: 0,
    zIndex: 2,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 8,
    background: "linear-gradient(180deg, rgba(29,29,31,0.92), rgba(29,29,31,0))",
  } as React.CSSProperties,

  assistantKicker: {
    color: "#6E98BC",
    fontSize: 10,
    fontWeight: 900,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
  } as React.CSSProperties,

  assistantTitle: {
    marginTop: 2,
    color: "#F5F5F7",
    fontSize: 16,
    fontWeight: 900,
  } as React.CSSProperties,

  assistantCloseButton: {
    width: 30,
    height: 30,
  } as React.CSSProperties,

  hero: {
    textAlign: "center",
    padding: "18px 0 38px",
    maxWidth: 860,
    margin: "0 auto",
  } as React.CSSProperties,

  heroSubline: {
    marginTop: 18,
    color: "#9A9AA3",
    fontSize: 15,
    lineHeight: 1.7,
  } as React.CSSProperties,

  composerWrap: {
    alignSelf: "center",
    width: "min(800px, calc(100% - 40px))",
    flexShrink: 0,
    minHeight: 64,
    gap: 8,
    padding: "10px 12px",
    marginBottom: 24,
    zIndex: 10,
    animation: "ml-composer-from-right 520ms cubic-bezier(0.16, 1, 0.3, 1) both",
  } as React.CSSProperties,

  input: {
    fontSize: 15,
    lineHeight: 1.5,
    resize: "none",
    minHeight: 24,
    maxHeight: 192,
    overflowY: "auto",
  } as React.CSSProperties,

  sendButton: {
    width: 44,
    height: 44,
    fontSize: 18,
  } as React.CSSProperties,

  composerMinimizeButton: {
    width: 40,
    height: 40,
    flexShrink: 0,
    color: "#A1A1A6",
  } as React.CSSProperties,

  assistantLauncher: {
    position: "absolute",
    right: 32,
    bottom: 32,
    zIndex: 12,
    minWidth: 122,
    height: 54,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
    padding: "0 18px",
    borderRadius: 999,
    fontSize: 14,
    fontWeight: 800,
    color: "#0B0B0C",
    boxShadow: "0 22px 70px rgba(54, 128, 180, 0.34), 0 0 34px rgba(155,207,204,0.14), inset 0 1px 0 rgba(255,255,255,0.38)",
    animation: "ml-slide-up 360ms cubic-bezier(0.16, 1, 0.3, 1) both",
  } as React.CSSProperties,
} as const;
