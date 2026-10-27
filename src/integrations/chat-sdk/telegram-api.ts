import { getKv, upsertKv } from "@/be/db";
import { scrubSecrets } from "@/utils/secret-scrubber";
import { getChatSdkConfig } from "./config";
import { errorMessage } from "./logger";

const TELEGRAM_TIMEOUT_MS = 10_000;
const TELEGRAM_TOPIC_NAME_MAX = 128;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars from user text
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f\u2028\u2029]+/g;

export const CHAT_TOPICS_NAMESPACE = "integrations:chat:topics";

export interface TelegramTopicRecord {
  name: string;
  createdByBot?: boolean;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Normalize a topic title to Telegram's 1..128 character range on a single line. */
export function formatTelegramTopicName(text: string): string {
  const cleaned = text.replace(CONTROL_CHARS_RE, " ").replace(/\s+/g, " ").trim();
  const sliced = cleaned.slice(0, TELEGRAM_TOPIC_NAME_MAX).trim();
  return sliced || "Task";
}

export function telegramTopicKvKey(chatId: string | number, topicId: string | number): string {
  const cleanChatId = String(chatId).replace(/^telegram:/, "");
  return `${cleanChatId}:${topicId}`;
}

/** Parse a `telegram:<chatId>:<topicId>` thread id; null for non-topic threads. */
export function parseTelegramTopicThreadId(
  threadId: string,
): { chatId: string; topicId: number } | null {
  const parts = threadId.split(":");
  if (parts[0] !== "telegram" || parts[1] === "biz" || parts.length !== 3) return null;
  const chatId = parts[1];
  const topicPart = parts[2];
  if (!chatId || !topicPart || !/^[1-9]\d*$/.test(topicPart)) return null;
  const topicId = Number.parseInt(topicPart, 10);
  if (!Number.isSafeInteger(topicId) || topicId <= 0) return null;
  return { chatId, topicId };
}

export async function getTelegramTopicRecord(
  chatId: string | number,
  topicId: string | number,
): Promise<TelegramTopicRecord | null> {
  const row = await getKv(CHAT_TOPICS_NAMESPACE, telegramTopicKvKey(chatId, topicId));
  if (!row || row.valueType !== "json" || !isRecord(row.value)) return null;
  const name = typeof row.value.name === "string" ? row.value.name : "";
  if (!name) return null;
  return {
    name,
    ...(row.value.createdByBot === true ? { createdByBot: true } : {}),
    updatedAt: typeof row.value.updatedAt === "string" ? row.value.updatedAt : row.updatedAt,
  };
}

export async function putTelegramTopicRecord(
  chatId: string | number,
  topicId: string | number,
  input: { name: string; createdByBot?: boolean },
): Promise<TelegramTopicRecord> {
  const existing = await getTelegramTopicRecord(chatId, topicId);
  const record: TelegramTopicRecord = {
    name: formatTelegramTopicName(input.name),
    ...((input.createdByBot ?? existing?.createdByBot) ? { createdByBot: true } : {}),
    updatedAt: new Date().toISOString(),
  };
  await upsertKv({
    namespace: CHAT_TOPICS_NAMESPACE,
    key: telegramTopicKvKey(chatId, topicId),
    value: record,
    valueType: "json",
  });
  return record;
}

/**
 * Extract and cache a forum topic title from a raw Telegram message when it
 * carries `forum_topic_created` or `forum_topic_edited` (either directly on a
 * service message or on `reply_to_message`).
 */
export async function recordTelegramTopicFromRawMessage(raw: unknown): Promise<void> {
  if (!isRecord(raw) || !isRecord(raw.chat)) return;
  const chatId = raw.chat.id;
  if (typeof chatId !== "number" && typeof chatId !== "string") return;

  const directCreated = isRecord(raw.forum_topic_created) ? raw.forum_topic_created : undefined;
  const directEdited = isRecord(raw.forum_topic_edited) ? raw.forum_topic_edited : undefined;
  const replyTo = isRecord(raw.reply_to_message) ? raw.reply_to_message : undefined;
  const replyCreated =
    raw.is_topic_message === true && replyTo && isRecord(replyTo.forum_topic_created)
      ? replyTo.forum_topic_created
      : undefined;
  const replyEdited =
    raw.is_topic_message === true && replyTo && isRecord(replyTo.forum_topic_edited)
      ? replyTo.forum_topic_edited
      : undefined;

  const rawName =
    (typeof directEdited?.name === "string" ? directEdited.name : undefined) ??
    (typeof directCreated?.name === "string" ? directCreated.name : undefined) ??
    (typeof replyEdited?.name === "string" ? replyEdited.name : undefined) ??
    (typeof replyCreated?.name === "string" ? replyCreated.name : undefined);
  if (!rawName || !rawName.trim()) return;

  const topicId =
    typeof raw.message_thread_id === "number"
      ? raw.message_thread_id
      : directCreated && typeof raw.message_id === "number"
        ? raw.message_id
        : undefined;
  if (typeof topicId !== "number" || topicId <= 0) return;

  try {
    await putTelegramTopicRecord(chatId, topicId, { name: rawName });
  } catch (error) {
    console.warn(`[chat-sdk] Could not cache Telegram topic name: ${errorMessage(error)}`);
  }
}

export async function resolveTelegramBotToken(): Promise<string | null> {
  const config = await getChatSdkConfig();
  const rawToken = config.adapters.telegram?.botToken;
  const token =
    typeof rawToken === "function" ? await (rawToken as () => Promise<string>)() : rawToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

/** A Bot API call that did not return `ok: true`. The message never carries the token. */
export class TelegramBotApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramBotApiError";
  }
}

/**
 * One Telegram Bot API call. Shared by the register-webhook action and the
 * command registration at adapter start, so both hit the same base URL
 * (`resolveAdapterApiUrl`) and scrub the token out of every error.
 */
export async function callTelegramBotApi(
  baseUrl: string,
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, "")}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new TelegramBotApiError(
        `Telegram ${method} failed: no response from the Bot API within ${TELEGRAM_TIMEOUT_MS / 1000} s`,
      );
    }
    // Fetch errors can echo the URL, which carries the bot token.
    throw new TelegramBotApiError(
      `Telegram ${method} failed: ${scrubSecrets(errorMessage(error).replaceAll(token, "[REDACTED]"))}`,
    );
  }
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    result?: unknown;
    description?: string;
  } | null;
  if (!response.ok || !payload?.ok) {
    const description = payload?.description ?? `HTTP ${response.status}`;
    throw new TelegramBotApiError(
      `Telegram ${method} failed: ${scrubSecrets(description.replaceAll(token, "[REDACTED]"))}`,
    );
  }
  return payload.result;
}

export async function createForumTopic(
  baseUrl: string,
  token: string,
  chatId: string | number,
  name: string,
): Promise<{ messageThreadId: number; name: string }> {
  const cleanChatId = String(chatId).replace(/^telegram:/, "");
  const topicName = formatTelegramTopicName(name);
  const result = await callTelegramBotApi(baseUrl, token, "createForumTopic", {
    chat_id: cleanChatId,
    name: topicName,
  });
  if (!isRecord(result) || typeof result.message_thread_id !== "number") {
    throw new TelegramBotApiError("Telegram createForumTopic returned an unexpected result");
  }
  const resolvedName =
    typeof result.name === "string" && result.name.trim() ? result.name.trim() : topicName;
  await putTelegramTopicRecord(cleanChatId, result.message_thread_id, {
    name: resolvedName,
    createdByBot: true,
  });
  return { messageThreadId: result.message_thread_id, name: resolvedName };
}

export async function closeForumTopic(
  baseUrl: string,
  token: string,
  chatId: string | number,
  messageThreadId: number,
): Promise<void> {
  const cleanChatId = String(chatId).replace(/^telegram:/, "");
  await callTelegramBotApi(baseUrl, token, "closeForumTopic", {
    chat_id: cleanChatId,
    message_thread_id: messageThreadId,
  });
}

export async function editForumTopic(
  baseUrl: string,
  token: string,
  chatId: string | number,
  messageThreadId: number,
  name: string,
): Promise<void> {
  const cleanChatId = String(chatId).replace(/^telegram:/, "");
  const topicName = formatTelegramTopicName(name);
  await callTelegramBotApi(baseUrl, token, "editForumTopic", {
    chat_id: cleanChatId,
    message_thread_id: messageThreadId,
    name: topicName,
  });
  await putTelegramTopicRecord(cleanChatId, messageThreadId, { name: topicName });
}
