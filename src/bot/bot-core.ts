import "dotenv/config";
import { nanoid } from "nanoid";
import { Telegraf, Context } from "telegraf";
import {
  getLastDeletedPosts,
  getLastPosts,
  getPostByUid,
  getPostsByDate,
  getPostTotals,
  getSummaryByDate,
  insertNewPost,
  restorePost,
  softDeletePost,
  softDeletePostByUid,
  updatePostContent,
  upsertSummary,
} from "../db/db-ops";
import { generateDailySummary } from "../services/summarize";

type AllowedUserMap = Record<string, true>;

type AiConfig = {
  openrouterApiKey: string;
  summaryModel: string;
};

function parseAllowedUsernames(raw: string): AllowedUserMap {
  const map: AllowedUserMap = {};
  raw
    .split(",")
    .map((username) => username.trim().toLowerCase())
    .filter(Boolean)
    .forEach((username) => {
      map[username] = true;
    });
  return map;
}

const KNOWN_COMMANDS = new Set(["delete", "which", "last", "restore", "trash", "stats", "summary"]);

type ReferenceableMessage = {
  message_id: number;
  date?: number;
  reply_to_message?: ReferenceableMessage;
};

function isUserAllowed(ctx: Context, allowedUsers: AllowedUserMap): boolean {
  const username = ctx.from?.username?.toLowerCase();
  if (!username) return false;
  return Boolean(allowedUsers[username]);
}

function isReplyMessage(ctx: Context): boolean {
  const message = ctx.message;
  if (!message) return false;
  return Boolean("reply_to_message" in message && message.reply_to_message);
}

function isCommandMessage(ctx: Context): boolean {
  const message = ctx.message;
  if (!message || !("text" in message)) return false;
  const entities = message.entities ?? [];
  return entities.some(
    (entity) => entity.type === "bot_command" && entity.offset === 0
  );
}

function parseCommandName(ctx: Context): string | null {
  const message = ctx.message;
  if (!message || !("text" in message)) return null;
  const entities = message.entities ?? [];
  const commandEntity = entities.find(
    (entity) => entity.type === "bot_command" && entity.offset === 0
  );
  if (!commandEntity) return null;
  const raw = message.text.slice(
    commandEntity.offset + 1,
    commandEntity.offset + commandEntity.length
  );
  return raw.split("@")[0].toLowerCase();
}

function parseCommandArg(ctx: Context): string | null {
  const message = ctx.message;
  if (!message || !("text" in message)) return null;
  const entities = message.entities ?? [];
  const commandEntity = entities.find(
    (entity) => entity.type === "bot_command" && entity.offset === 0
  );
  if (!commandEntity) return null;
  const after = message.text
    .slice(commandEntity.offset + commandEntity.length)
    .trim();
  return after.length > 0 ? after : null;
}

function getReplyTarget(
  message: Context["message"]
): ReferenceableMessage | null {
  if (
    message &&
    typeof message === "object" &&
    "reply_to_message" in message
  ) {
    const candidate = (message as { reply_to_message?: unknown })
      .reply_to_message;
    if (
      candidate &&
      typeof candidate === "object" &&
      "message_id" in candidate
    ) {
      return candidate as ReferenceableMessage;
    }
  }
  return null;
}

function isOriginalPostReference(
  message: ReferenceableMessage | null
): boolean {
  if (!message) return false;
  return !message.reply_to_message;
}

function getMessageText(message: Context["message"]): string | null {
  if (message && "text" in message && typeof message.text === "string") {
    const trimmed = message.text.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function formatBotTimestamp(date: Date): string {
  const day = date.getUTCDate().toString().padStart(2, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const year = date.getUTCFullYear().toString().slice(2);
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  return `${day}/${month}/${year} ${hours}:${minutes}`;
}

function formatPostMessage(content: string, createdAt: Date, uid: string): string {
  return `${content}\n-- ${formatBotTimestamp(createdAt)} | ${uid}`;
}

function formatAuthor(ctx: Context): string {
  if (ctx.from?.username) return `@${ctx.from.username}`;
  if (ctx.from?.first_name || ctx.from?.last_name) {
    return `${ctx.from?.first_name ?? ""} ${ctx.from?.last_name ?? ""}`.trim();
  }
  return `user-${ctx.from?.id ?? "unknown"}`;
}

function formatTimestamp(ctx: Context): string {
  const unixSeconds = ctx.message?.date;
  if (unixSeconds) {
    return new Date(unixSeconds * 1000).toISOString();
  }
  return new Date().toISOString();
}

async function sendMessage(
  ctx: Context,
  chatId: number | string | undefined,
  replyToMessageId: number,
  text: string
): Promise<void> {
  if (chatId === undefined) {
    await ctx.reply(text);
    return;
  }
  await ctx.telegram.sendMessage(chatId, text, {
    reply_to_message_id: replyToMessageId,
    allow_sending_without_reply: true,
  } as Record<string, unknown>);
}

function parseSummaryDate(arg: string | null): string | null {
  const IST_OFFSET_MS = 330 * 60 * 1000;
  const istNow = new Date(Date.now() + IST_OFFSET_MS);
  if (!arg || arg === "today" || arg === "0") {
    return istNow.toISOString().slice(0, 10);
  }
  if (arg === "yesterday" || arg === "1") {
    istNow.setUTCDate(istNow.getUTCDate() - 1);
    return istNow.toISOString().slice(0, 10);
  }
  const n = parseInt(arg, 10);
  if (!isNaN(n) && n >= 0 && String(n) === arg) {
    istNow.setUTCDate(istNow.getUTCDate() - n);
    return istNow.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg) && !isNaN(Date.parse(arg))) {
    return arg;
  }
  return null;
}

function formatSummaryDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = d.getUTCDate().toString().padStart(2, "0");
  const month = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const year = d.getUTCFullYear().toString().slice(2);
  return `${day}/${month}/${year}`;
}

function formatIstTimestamp(date: Date): string {
  const IST_OFFSET_MS = 330 * 60 * 1000;
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const day = ist.getUTCDate().toString().padStart(2, "0");
  const month = (ist.getUTCMonth() + 1).toString().padStart(2, "0");
  const year = ist.getUTCFullYear().toString().slice(2);
  const hours = ist.getUTCHours().toString().padStart(2, "0");
  const minutes = ist.getUTCMinutes().toString().padStart(2, "0");
  return `${day}/${month}/${year} ${hours}:${minutes}`;
}

function formatSummaryFooter(generatedAt: Date, summaryDate: string, model: string): string {
  return `-- ${formatIstTimestamp(generatedAt)} | summary for ${formatSummaryDate(summaryDate)} via ${model}`;
}

function getTodayIst(): string {
  const IST_OFFSET_MS = 330 * 60 * 1000;
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function attachMessageHandlers(bot: Telegraf, allowedUsers: AllowedUserMap, aiConfig?: AiConfig): void {
  bot.on("message", async (ctx) => {
    if (!isUserAllowed(ctx, allowedUsers)) {
      console.warn(
        "Unauthorized message from",
        ctx.from?.username ?? ctx.from?.id ?? "unknown user"
      );
      await ctx.reply("unauthorized");
      return;
    }

    const incomingMessage = ctx.message;
    if (!incomingMessage) {
      console.warn("Received message update without message payload.");
      return;
    }

    const chatId = ctx.chat?.id;
    const timestamp = formatTimestamp(ctx);
    const authorLabel = formatAuthor(ctx);
    const content =
      "text" in incomingMessage
        ? incomingMessage.text
        : JSON.stringify(incomingMessage, null, 2);

    console.log(
      `[${timestamp}] message #${incomingMessage.message_id} from ${authorLabel}:`,
      content
    );

    const replyTarget = getReplyTarget(incomingMessage);
    let response = "no action taken";

    try {
      if (isCommandMessage(ctx)) {
        const commandName = parseCommandName(ctx);
        const commandArg = parseCommandArg(ctx);

        if (!commandName || !KNOWN_COMMANDS.has(commandName)) {
          response = "error | command not found";
          await sendMessage(ctx, chatId, incomingMessage.message_id, response);
          return;
        }

        if (commandName === "delete") {
          if (commandArg) {
            const deleted = await softDeletePostByUid(commandArg);
            response = deleted
              ? `${deleted.uid} | deleted`
              : "error | post not found";
          } else if (replyTarget) {
            if (!isOriginalPostReference(replyTarget)) {
              response = "error | reply to the original post to delete";
            } else {
              const deleted = await softDeletePost({
                targetTelegramMessageId: replyTarget.message_id,
                deletedAt: new Date(),
              });
              response = deleted
                ? `${deleted.uid} | deleted`
                : "error | post not found";
            }
          } else {
            response = "error | reply to a post or provide a post id";
          }
          await sendMessage(ctx, chatId, incomingMessage.message_id, response);
          return;
        }

        if (commandName === "which") {
          if (!commandArg) {
            response = "error | provide a post id";
            await sendMessage(ctx, chatId, incomingMessage.message_id, response);
            return;
          }
          const post = await getPostByUid(commandArg);
          if (!post) {
            response = "post not found";
          } else if (post.deleted) {
            response = "post is deleted";
          } else {
            response = formatPostMessage(post.content, post.createdAt, post.uid);
          }
          await sendMessage(ctx, chatId, incomingMessage.message_id, response);
          return;
        }

        if (commandName === "last") {
          const n = commandArg ? Math.min(parseInt(commandArg, 10) || 1, 10) : 1;
          const lastPosts = await getLastPosts(n);
          if (lastPosts.length === 0) {
            await sendMessage(ctx, chatId, incomingMessage.message_id, "no posts found");
            return;
          }
          for (const post of lastPosts) {
            await sendMessage(
              ctx,
              chatId,
              incomingMessage.message_id,
              formatPostMessage(post.content, post.createdAt, post.uid)
            );
          }
          return;
        }

        if (commandName === "restore") {
          if (!commandArg) {
            response = "error | provide a post id";
            await sendMessage(ctx, chatId, incomingMessage.message_id, response);
            return;
          }
          const restored = await restorePost(commandArg);
          response = restored
            ? `${restored.uid} | restored`
            : "error | post not found";
          await sendMessage(ctx, chatId, incomingMessage.message_id, response);
          return;
        }

        if (commandName === "stats") {
          const totals = await getPostTotals();
          response = `total : ${totals.total}\ndeleted : ${totals.deleted}\nvisible : ${totals.visible}`;
          await sendMessage(ctx, chatId, incomingMessage.message_id, response);
          return;
        }

        if (commandName === "summary") {
          if (!aiConfig) {
            response = "error | AI summarization is not configured";
            await sendMessage(ctx, chatId, incomingMessage.message_id, response);
            return;
          }

          let forceRegen = false;
          let rawArg = commandArg;
          if (commandArg?.startsWith("regen")) {
            forceRegen = true;
            rawArg = commandArg.slice("regen".length).trim() || null;
          }

          const dateStr = parseSummaryDate(rawArg);
          if (!dateStr) {
            response = "error | invalid date. Use: today, 0, 1, 2, yesterday, YYYY-MM-DD, or regen <date>";
            await sendMessage(ctx, chatId, incomingMessage.message_id, response);
            return;
          }

          if (dateStr > getTodayIst()) {
            response = "error | date is in the future";
            await sendMessage(ctx, chatId, incomingMessage.message_id, response);
            return;
          }

          if (!forceRegen) {
            const cached = await getSummaryByDate(dateStr);
            if (cached) {
              response = `${cached.content}\n${formatSummaryFooter(cached.generatedAt, dateStr, cached.model)}`;
              await sendMessage(ctx, chatId, incomingMessage.message_id, response);
              return;
            }
          }

          const prevDate = new Date(dateStr + "T00:00:00Z");
          prevDate.setUTCDate(prevDate.getUTCDate() - 1);
          const prevSummary = await getSummaryByDate(prevDate.toISOString().slice(0, 10));

          const dayPosts = await getPostsByDate(dateStr);
          if (dayPosts.length === 0) {
            response = `no posts found for ${dateStr}`;
            await sendMessage(ctx, chatId, incomingMessage.message_id, response);
            return;
          }

          const content = await generateDailySummary(
            dayPosts,
            aiConfig.openrouterApiKey,
            aiConfig.summaryModel,
            prevSummary?.content
          );

          const generatedAt = new Date();
          await upsertSummary({
            date: dateStr,
            content,
            postsCount: dayPosts.length,
            model: aiConfig.summaryModel,
            generatedAt,
          });

          response = `${content}\n${formatSummaryFooter(generatedAt, dateStr, aiConfig.summaryModel)}`;
          await sendMessage(ctx, chatId, incomingMessage.message_id, response);
          return;
        }

        if (commandName === "trash") {
          const n = commandArg ? Math.min(parseInt(commandArg, 10) || 1, 10) : 1;
          const deletedPosts = await getLastDeletedPosts(n);
          if (deletedPosts.length === 0) {
            await sendMessage(ctx, chatId, incomingMessage.message_id, "no deleted posts");
            return;
          }
          for (const post of deletedPosts) {
            await sendMessage(
              ctx,
              chatId,
              incomingMessage.message_id,
              formatPostMessage(post.content, post.createdAt, post.uid)
            );
          }
          return;
        }
      } else if (replyTarget) {
        const newContent = getMessageText(incomingMessage);
        const editorId = ctx.from?.id;
        if (!newContent) {
          response = "error | edit reply must include text content";
        } else if (typeof editorId !== "number") {
          response = "error | missing editor id";
        } else {
          const edited = await updatePostContent({
            targetTelegramMessageId: replyTarget.message_id,
            newContent,
            editedBy: editorId,
            editedAt:
              typeof incomingMessage.date === "number"
                ? new Date(incomingMessage.date * 1000)
                : new Date(),
          });
          response = edited ? `${edited.uid} | updated` : "error | post not found";
        }
        await sendMessage(ctx, chatId, incomingMessage.message_id, response);
        return;
      } else {
        const telegramMessageId = incomingMessage.message_id;
        const authorTelegramId = ctx.from?.id;
        const text = getMessageText(incomingMessage);
        const messageDate =
          typeof incomingMessage.date === "number"
            ? new Date(incomingMessage.date * 1000)
            : new Date();

        if (!text) {
          response = "error | message must contain text";
        } else if (typeof telegramMessageId !== "number") {
          response = "error | could not read message id";
        } else {
          const uid = nanoid(10);
          const inserted = await insertNewPost({
            uid,
            telegramMessageId,
            authorTelegramId,
            content: text,
            timestamp: messageDate,
            origin: "tg",
          });
          response = inserted
            ? `${inserted.uid} | inserted successfully`
            : "error | post already exists for this message";
        }
        await sendMessage(ctx, chatId, incomingMessage.message_id, response);
        return;
      }
    } catch (error) {
      console.error("Failed to process message:", error);
      response = "error | internal error, please retry";
      await sendMessage(ctx, chatId, incomingMessage.message_id, response);
    }
  });
}

// For production (CF Workers webhook mode): create a configured bot instance
// without starting long polling. The caller is responsible for calling
// bot.handleUpdate(update) per incoming Telegram update.
export function createBot(token: string, allowedUsernamesStr: string, aiConfig?: AiConfig): Telegraf {
  const allowedUsers = parseAllowedUsernames(allowedUsernamesStr);
  const bot = new Telegraf(token);
  attachMessageHandlers(bot, allowedUsers, aiConfig);
  return bot;
}

// For local dev: start the bot with long polling.
export async function startLoggingBot(): Promise<void> {
  const botToken = process.env.BOT_TOKEN;
  if (!botToken) {
    throw new Error(
      "BOT_TOKEN is missing. Set it in your environment to run the bot."
    );
  }

  const allowedUsers = parseAllowedUsernames(process.env.ALLOWED_USERNAMES ?? "");
  const aiConfig = process.env.OPENROUTER_API_KEY
    ? {
        openrouterApiKey: process.env.OPENROUTER_API_KEY,
        summaryModel: process.env.SUMMARY_MODEL ?? "google/gemini-2.0-flash-001",
      }
    : undefined;
  const bot = new Telegraf(botToken);
  attachMessageHandlers(bot, allowedUsers, aiConfig);

  await bot.launch();
  console.log("Telegraf bot is running (long polling). Press Ctrl+C to stop.");

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, stopping bot...`);
    bot.stop(signal);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  startLoggingBot().catch((error) => {
    console.error("Bot failed to start:", error);
    process.exitCode = 1;
  });
}
