const BASE_URL = "https://buyer-chat-api.wildberries.ru";

const TARGET_TEXT =
  "Здравствуйте. Вы оставили отзыв с низкой оценкой. " +
  "Давайте обсудим, что не так с товаром. " +
  "Пожалуйста, расскажите подробно: попробую решить проблему";

const DAYS_BACK = 1;
const SEED_DAYS_BACK = 1;
const MAX_PAGES = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getNewEvents(headers, startCursor, log) {
  const events = [];
  let nextCursor = startCursor;
  let page = 0;

  while (true) {
    page += 1;
    if (page > MAX_PAGES) {
      log(`! MAX_PAGES=${MAX_PAGES} достигнут, останавливаюсь`);
      break;
    }

    const url = new URL(`${BASE_URL}/api/v1/seller/events`);
    if (nextCursor !== null) url.searchParams.set("next", nextCursor);

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      throw new Error(`Ошибка запроса events: ${resp.status} ${await resp.text()}`);
    }
    const data = await resp.json();
    const result = data.result || {};
    const batch = result.events || [];
    events.push(...batch);

    const total = result.totalEvents || 0;
    nextCursor = result.next ?? nextCursor;

    log(`Страница ${page}: получено ${batch.length} (накоплено: ${events.length})`);

    if (total === 0 || batch.length === 0) break;
    await sleep(1100); // лимит 10 запросов / 10 секунд
  }

  return { events, lastCursor: nextCursor };
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
      });
    }
  }
  return targets;
}

async function sendMessage(headers, replySign, text) {
  const form = new FormData();
  form.append("replySign", replySign);
  form.append("message", text);

  const resp = await fetch(`${BASE_URL}/api/v1/seller/message`, {
    method: "POST",
    headers,
    body: form,
  });

  if (!resp.ok) {
    throw new Error(`Ошибка отправки: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

async function runBot(env) {
  const logs = [];
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    logs.push(line);
  };

  const headers = { Authorization: env.WB_API_TOKEN };
  const dryRun = env.DRY_RUN === "true";

  log(`Старт. Режим: ${dryRun ? "DRY_RUN" : "БОЕВОЙ"}`);

  let cursor = await env.WB_STATE.get("cursor");
  if (cursor === null) {
    cursor = String(Date.now() - SEED_DAYS_BACK * 24 * 60 * 60 * 1000);
    log(`Курсора в KV нет — сею на ${SEED_DAYS_BACK} сут назад: ${cursor}`);
  } else {
    log(`Загружен курсор из KV: ${cursor}`);
  }

  const { events, lastCursor } = await getNewEvents(headers, cursor, log);
  log(`Новых событий: ${events.length}`);

  const recent = filterRecent(events, DAYS_BACK);
  log(`За последние ${DAYS_BACK} сутки: ${recent.length}`);

  const chatsEvents = groupByChat(recent);
  const targets = findTargets(chatsEvents);
  log(`Подходят под условие (нет ответа покупателя): ${targets.length}`);

  for (const t of targets) {
    log(` - ${t.clientName}, чат ${t.chatId}`);
  }

  if (dryRun) {
    log("DRY_RUN=true — сообщения не отправлены.");
  } else {
    let sent = 0;
    let failed = 0;
    for (const { chatId, replySign, clientName } of targets) {
      if (!replySign) {
        log(`! Нет replySign для ${chatId}`);
        failed++;
        continue;
      }
      try {
        await sendMessage(headers, replySign, env.NEW_MESSAGE_TEXT);
        log(`+ Отправлено: ${clientName} (${chatId})`);
        sent++;
      } catch (err) {
        log(`! Ошибка отправки ${chatId}: ${err.message}`);
        failed++;
      }
      await sleep(1100);
    }
    log(`Отправлено: ${sent}, ошибок: ${failed}`);
  }

  await env.WB_STATE.put("cursor", lastCursor);
  log("Готово.");

  return logs.join("\n");
}

export default {
  // Срабатывает по расписанию (cron из wrangler.toml)
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runBot(env));
  },

  // Срабатывает, если просто зайти по URL воркера в браузере —
  // удобно для ручной проверки без ожидания расписания
  async fetch(request, env) {
    const result = await runBot(env);
    return new Response(result, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
