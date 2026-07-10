/**
 * Бот для Wildberries: находит чаты, где продавец написал определённое
 * сообщение и покупатель на него НЕ ответил (сообщение продавца - последнее
 * в чате), и отправляет туда ещё одно сообщение.
 *
 * Запуск: node wb_chat_bot.js
 * DRY_RUN=true по умолчанию — ничего не отправляет, только показывает план.
 */

const API_TOKEN = process.env.WB_API_TOKEN;
const BASE_URL = "https://buyer-chat-api.wildberries.ru";

const TARGET_TEXT =
  "Здравствуйте. Вы оставили отзыв с низкой оценкой. " +
  "Давайте обсудим, что не так с товаром. " +
  "Пожалуйста, расскажите подробно: попробую решить проблему";

const DAYS_BACK = 1;

const NEW_MESSAGE_TEXT =
  "Данное сообщение отправлено автоматически. Пожалуйста, не отвечайте на него. " +
  "Если Вы считаете, что получили сообщение по ошибке, просто удалите или проигнорируйте его.";

const DRY_RUN = true;

const HEADERS = { Authorization: API_TOKEN };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowStr() {
  return new Date().toISOString().split("T")[1].split(".")[0]; // HH:MM:SS
}

function log(msg) {
  console.log(`[${nowStr()}] ${msg}`);
}

async function getAllEvents() {
  const events = [];
  let nextCursor = null;
  let page = 0;

  while (true) {
    page += 1;
    const url = new URL(`${BASE_URL}/api/v1/seller/events`);
    if (nextCursor !== null) url.searchParams.set("next", nextCursor);

    const resp = await fetch(url, { headers: HEADERS });
    if (!resp.ok) {
      throw new Error(`Ошибка запроса events: ${resp.status} ${await resp.text()}`);
    }
    const data = await resp.json();

    const result = data.result || {};
    const batch = result.events || [];
    events.push(...batch);

    const total = result.totalEvents || 0;
    nextCursor = result.next;

    log(`Страница ${page}: получено ${batch.length} событий (накоплено: ${events.length})`);

    if (total === 0 || batch.length === 0) break;

    await sleep(1100); // лимит 10 запросов / 10 секунд
  }

  return events;
}

function filterRecent(events, daysBack) {
  const cutoffMs = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  return events.filter((e) => (e.addTimestamp || 0) >= cutoffMs);
}

function groupByChat(events) {
  const chats = {};
  for (const e of events) {
    if (e.eventType !== "message") continue;
    if (!chats[e.chatID]) chats[e.chatID] = [];
    chats[e.chatID].push(e);
  }
  for (const chatId of Object.keys(chats)) {
    chats[chatId].sort((a, b) => (a.addTimestamp || 0) - (b.addTimestamp || 0));
  }
  return chats;
}

function findTargets(chatsEvents) {
  // Подходит чат, если последнее сообщение в нём — от продавца и совпадает
  // с TARGET_TEXT (значит, покупатель после этого ничего не ответил).
  const targets = [];

  for (const [chatId, msgs] of Object.entries(chatsEvents)) {
    const last = msgs[msgs.length - 1];
    const lastText = (last.message && last.message.text) || "";

    const isSeller = last.sender === "seller";
    const textMatches = lastText.trim() === TARGET_TEXT.trim();

    if (isSeller && textMatches) {
      targets.push({
        chatId,
        replySign: last.replySign,
        clientName: last.clientName || "без имени",
        sentAgo: Date.now() - (last.addTimestamp || 0),
      });
    }
  }

  return targets;
}

function formatAgo(ms) {
  const hours = Math.floor(ms / 1000 / 60 / 60);
  const minutes = Math.floor((ms / 1000 / 60) % 60);
  return `${hours}ч ${minutes}м назад`;
}

async function sendMessage(replySign, text) {
  const form = new FormData();
  form.append("replySign", replySign);
  form.append("message", text);

  const resp = await fetch(`${BASE_URL}/api/v1/seller/message`, {
    method: "POST",
    headers: HEADERS,
    body: form,
  });

  if (!resp.ok) {
    throw new Error(`Ошибка отправки: ${resp.status} ${await resp.text()}`);
  }

  return resp.json();
}

async function main() {
  const startedAt = Date.now();
  log(`Старт проверки. Период: последние ${DAYS_BACK} сутки. Режим: ${DRY_RUN ? "DRY_RUN" : "БОЕВОЙ"}`);

  const events = await getAllEvents();
  const recent = filterRecent(events, DAYS_BACK);
  log(`Событий за период: ${recent.length} из ${events.length} всего`);

  const chatsEvents = groupByChat(recent);
  log(`Активных чатов за период: ${Object.keys(chatsEvents).length}`);

  const targets = findTargets(chatsEvents);
  log(`Подходят под условие (нет ответа покупателя): ${targets.length}`);

  for (const { chatId, clientName, sentAgo } of targets) {
    log(` - ${clientName}, чат ${chatId}, наше сообщение отправлено ${formatAgo(sentAgo)}`);
  }

  if (DRY_RUN) {
    log("DRY_RUN=true — сообщения не отправлены. Поставьте DRY_RUN=false для реальной отправки.");
    return;
  }

  let sent = 0;
  let failed = 0;

  for (const { chatId, replySign, clientName } of targets) {
    if (!replySign) {
      log(` ! Нет replySign для чата ${chatId} (${clientName}), пропуск`);
      failed += 1;
      continue;
    }
    try {
      await sendMessage(replySign, NEW_MESSAGE_TEXT);
      log(` + Отправлено: ${clientName} (чат ${chatId})`);
      sent += 1;
    } catch (err) {
      log(` ! Ошибка отправки в чат ${chatId} (${clientName}): ${err.message}`);
      failed += 1;
    }
    await sleep(1100);
  }

  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`Готово за ${durationSec}с. Отправлено: ${sent}, ошибок: ${failed}`);
}

main().catch((err) => {
  console.error(`[${nowStr()}] Критическая ошибка:`, err);
  process.exit(1);
});
