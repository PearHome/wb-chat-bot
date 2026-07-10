/**
 * Бот для Wildberries: находит чаты, где продавец написал определённое
 * сообщение и покупатель на него НЕ ответил (сообщение продавца - последнее
 * в чате), и отправляет туда ещё одно сообщение.
 *
 * Запуск: node wb_chat_bot.js
 * DRY_RUN=true по умолчанию — ничего не отправляет, только показывает план.
 *
 * ПЕРСИСТЕНТНЫЙ КУРСОР:
 * У /seller/events нет официального фильтра по дате — только курсор next.
 * Курсор сохраняется в STATE_FILE между запусками, чтобы не перечитывать
 * всю историю каждый раз.
 *
 * "ПОСЕВ" СТАРТОВОГО КУРСОРА (экспериментально):
 * По наблюдениям сообщества, next — это unix-timestamp в мс, и в него можно
 * подставить произвольное значение, а не только то, что вернул сам WB.
 * Поэтому при самом первом запуске (файла состояния ещё нет) вместо полного
 * прохода по истории с начала времён скрипт стартует сразу с отметки
 * "SEED_DAYS_BACK суток назад". Это НЕ задокументированное официально
 * поведение — после первого запуска смотрите в лог блок "ПРОВЕРКА ПОСЕВА"
 * и убедитесь, что даты полученных событий близки к ожидаемым, а не из
 * глубокой истории. Если проверка не сходится — уберите посев (см. ниже).
 */

const fs = require("fs");

const API_TOKEN = process.env.WB_API_TOKEN;
const BASE_URL = "https://buyer-chat-api.wildberries.ru";
const STATE_FILE = process.env.STATE_FILE || "state.json";

const TARGET_TEXT =
  "Здравствуйте. Вы оставили отзыв с низкой оценкой. " +
  "Давайте обсудим, что не так с товаром. " +
  "Пожалуйста, расскажите подробно: попробую решить проблему";

const DAYS_BACK = 1;

// На сколько суток назад "сеять" курсор при самом первом запуске.
// Поставьте null, чтобы отключить посев и всегда идти с самого начала истории.
const SEED_DAYS_BACK = 1;

const NEW_MESSAGE_TEXT =
  "Данное сообщение отправлено автоматически. Пожалуйста, не отвечайте на него. " +
  "Если Вы считаете, что получили сообщение по ошибке, просто удалите или проигнорируйте его.";

// Управляется переменной окружения DRY_RUN из workflow-файла.
// Явно "false" -> боевой режим. Всё остальное (включая отсутствие переменной) -> dry run.
const DRY_RUN = process.env.DRY_RUN !== "false";

// Предохранитель от зависаний: если вдруг посев не сработал и пошёл полный
// проход по истории, не даём скрипту работать бесконечно.
const MAX_PAGES = 2000;

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

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    if (SEED_DAYS_BACK !== null) {
      const seedCursor = String(Date.now() - SEED_DAYS_BACK * 24 * 60 * 60 * 1000);
      log(`Файла состояния нет — первый запуск. Сею курсор на ${SEED_DAYS_BACK} сут. назад: ${seedCursor} (экспериментально, будет проверка ниже)`);
      return { cursor: seedCursor, seeded: true };
    }
    log(`Файла состояния нет — первый запуск, посев отключён, идём с самого начала истории`);
    return { cursor: null, seeded: false };
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const state = JSON.parse(raw);
    log(`Загружен сохранённый курсор: ${state.cursor}`);
    return state;
  } catch (err) {
    log(`Не удалось прочитать ${STATE_FILE} (${err.message}), стартуем заново`);
    return { cursor: null, seeded: false };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  log(`Курсор сохранён в ${STATE_FILE}: ${state.cursor}`);
}

async function getNewEvents(startCursor) {
  const events = [];
  let nextCursor = startCursor;
  let page = 0;

  while (true) {
    page += 1;

    if (page > MAX_PAGES) {
      log(`! Достигнут предохранитель MAX_PAGES=${MAX_PAGES}. Останавливаюсь досрочно, сохраню то, что есть.`);
      break;
    }

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
    nextCursor = result.next ?? nextCursor;

    if (page === 1 || page % 20 === 0 || total === 0) {
      log(`Страница ${page}: получено ${batch.length} событий (накоплено: ${events.length})`);
    }

    if (total === 0 || batch.length === 0) break;

    await sleep(1100); // лимит 10 запросов / 10 секунд
  }

  return { events, lastCursor: nextCursor };
}

function checkSeed(events, seedCursorMs) {
  // Сверяем, действительно ли посев сработал: даты первых полученных событий
  // должны быть близки к ожидаемой точке отсчёта, а не из глубокой истории.
  if (events.length === 0) {
    log("ПРОВЕРКА ПОСЕВА: событий не получено, сверить не с чем — само по себе не ошибка");
    return;
  }

  const timestamps = events.map((e) => e.addTimestamp || 0).filter(Boolean);
  if (timestamps.length === 0) {
    log("ПРОВЕРКА ПОСЕВА: не удалось прочитать даты событий, пропускаю проверку");
    return;
  }

  const oldest = Math.min(...timestamps);
  const diffHours = (oldest - seedCursorMs) / 1000 / 60 / 60;

  log(`ПРОВЕРКА ПОСЕВА: самое старое полученное событие — ${new Date(oldest).toISOString()}`);

  if (diffHours < -6) {
    log(
      `! ПОСЕВ, ПОХОЖЕ, НЕ СРАБОТАЛ: получены события заметно старше точки посева ` +
        `(${new Date(seedCursorMs).toISOString()}). Возможно, WB игнорирует произвольный next. ` +
        `Рекомендация: поставьте SEED_DAYS_BACK = null и удалите state.json, чтобы честно пройти всю историю один раз.`
    );
  } else {
    log("Посев выглядит корректным — события начинаются примерно с ожидаемой точки.");
  }
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
  log(`Старт проверки. Режим: ${DRY_RUN ? "DRY_RUN" : "БОЕВОЙ"}`);

  const state = loadState();
  const { events, lastCursor } = await getNewEvents(state.cursor);
  log(`Всего новых событий с прошлого запуска: ${events.length}`);

  if (state.seeded) {
    checkSeed(events, Number(state.cursor));
  }

  const recent = filterRecent(events, DAYS_BACK);
  log(`Из них за последние ${DAYS_BACK} сутки: ${recent.length}`);

  const chatsEvents = groupByChat(recent);
  log(`Активных чатов за период: ${Object.keys(chatsEvents).length}`);

  const targets = findTargets(chatsEvents);
  log(`Подходят под условие (нет ответа покупателя): ${targets.length}`);

  for (const { chatId, clientName, sentAgo } of targets) {
    log(` - ${clientName}, чат ${chatId}, наше сообщение отправлено ${formatAgo(sentAgo)}`);
  }

  if (DRY_RUN) {
    log("DRY_RUN=true — сообщения не отправлены. Поставьте DRY_RUN=false для реальной отправки.");
  } else {
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

    log(`Отправлено: ${sent}, ошибок: ${failed}`);
  }

  saveState({ cursor: lastCursor, updatedAt: new Date().toISOString() });

  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`Готово за ${durationSec}с.`);
}

main().catch((err) => {
  console.error(`[${nowStr()}] Критическая ошибка:`, err);
  process.exit(1);
});
