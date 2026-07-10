/**
 * Бот для Wildberries: находит чаты, где продавец написал определённое
 * сообщение и покупатель на него НЕ ответил (сообщение продавца - последнее
 * в чате), и отправляет туда ещё одно сообщение.
 *
 * Требования: Node.js 18+ (встроенный fetch, доп. пакеты не нужны)
 * Запуск: node wb_chat_bot.js
 *
 * ВАЖНО:
 * - По умолчанию DRY_RUN = true — скрипт только печатает, в какие чаты
 *   отправил бы сообщение, но ничего не шлёт. Проверьте вывод, и только
 *   потом ставьте DRY_RUN = false.
 * - У метода /seller/events нет фильтра по дате, поэтому скрипт вычитывает
 *   ВСЕ события через пагинацию (курсор next) и сам отфильтровывает нужный
 *   период. Есть паузы между запросами (лимит 10 запросов / 10 секунд).
 */

// ========================= НАСТРОЙКИ =========================

const API_TOKEN = process.env.WB_API_TOKEN;
const BASE_URL = "https://buyer-chat-api.wildberries.ru";

// Текст сообщения продавца, которое ищем
const TARGET_TEXT =
  "Здравствуйте. Вы оставили отзыв с низкой оценкой. " +
  "Давайте обсудим, что не так с товаром. " +
  "Пожалуйста, расскажите подробно: попробую решить проблему";

// За сколько последних дней проверяем чаты
const DAYS_BACK = 3;

// Текст нового сообщения, которое нужно отправить 
const NEW_MESSAGE_TEXT = "Данное сообщение отправлено автоматически. Пожалуйста, не отвечайте на него. Если Вы считаете, что получили сообщение по ошибке, просто удалите или проигнорируйте его.";

// Пока true — ничего реально не отправляет, только показывает план действий
const DRY_RUN = true;

// =================================================================

const HEADERS = { Authorization: API_TOKEN };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAllEvents() {
  const events = [];
  let nextCursor = null;

  while (true) {
    const url = new URL(`${BASE_URL}/api/v1/seller/events`);
    if (nextCursor !== null) {
      url.searchParams.set("next", nextCursor);
    }

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

    console.log(`Получено событий: ${batch.length} (всего накоплено: ${events.length})`);

    if (total === 0 || batch.length === 0) {
      break;
    }

    // Уважаем лимит 10 запросов / 10 секунд
    await sleep(1100);
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
    const chatId = e.chatID;
    if (!chats[chatId]) chats[chatId] = [];
    chats[chatId].push(e);
  }
  for (const chatId of Object.keys(chats)) {
    chats[chatId].sort((a, b) => (a.addTimestamp || 0) - (b.addTimestamp || 0));
  }
  return chats;
}

function findTargets(chatsEvents) {
  // Возвращает список чатов, где:
  // - есть сообщение продавца с TARGET_TEXT
  // - это сообщение последнее в чате (после него ничего нет, в т.ч. ответа покупателя)
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
        clientName: last.clientName || "",
      });
    }
  }

  return targets;
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
  console.log("Скачиваю события чатов...");
  const events = await getAllEvents();

  console.log(`Фильтрую события за последние ${DAYS_BACK} дн...`);
  const recent = filterRecent(events, DAYS_BACK);
  console.log(`Событий за период: ${recent.length}`);

  const chatsEvents = groupByChat(recent);
  console.log(`Чатов за период: ${Object.keys(chatsEvents).length}`);

  const targets = findTargets(chatsEvents);
  console.log(`\nНайдено чатов, подходящих под условие: ${targets.length}`);

  for (const { chatId, clientName } of targets) {
    console.log(` - chatID=${chatId}, покупатель=${clientName}`);
  }

  if (DRY_RUN) {
    console.log(
      "\nDRY_RUN=true — сообщения НЕ отправлены. " +
        "Проверьте список выше и поставьте DRY_RUN=false для реальной отправки."
    );
    return;
  }

  console.log("\nОтправляю сообщения...");
  for (const { chatId, replySign, clientName } of targets) {
    if (!replySign) {
      console.log(` ! Нет replySign для чата ${chatId}, пропуск`);
      continue;
    }
    try {
      const result = await sendMessage(replySign, NEW_MESSAGE_TEXT);
      console.log(` + Отправлено в чат ${chatId} (${clientName}):`, result);
    } catch (err) {
      console.log(` ! Ошибка при отправке в чат ${chatId}: ${err.message}`);
    }
    await sleep(1100); // уважаем лимит запросов
  }
}

main().catch((err) => {
  console.error("Критическая ошибка:", err);
  process.exit(1);
});
