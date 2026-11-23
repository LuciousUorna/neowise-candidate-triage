import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";

const ALLOWED_TOPICS = ["delivery", "pricing", "other"];
export const DEFAULT_MODEL_TIMEOUT_MS = 300;

// Тела ответов строго по заданию: причина отказа уходит в лог, а не клиенту.
const INVALID_INPUT_BODY = Object.freeze({ status: "invalid_input" });
const MANUAL_REVIEW_BODY = Object.freeze({ status: "manual_review", topic: null, draft: null });

const STATIC_FILES = [
  { url: "/", file: "index.html", type: "text/html; charset=utf-8" },
  { url: "/triage-ui.mjs", file: "triage-ui.mjs", type: "text/javascript; charset=utf-8" },
];

const assets = new Map(
  await Promise.all(
    STATIC_FILES.map(async ({ url, file, type }) => [
      url,
      { body: await readFile(new URL(`./${file}`, import.meta.url)), type },
    ]),
  ),
);

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

/** Одна строка в лог на каждый отказ: видно, сколько заявок и почему ушло на ручной разбор. */
function respondFailure(response, deps, httpStatus, body, reason, startedAt) {
  deps.logger.warn(
    `triage_failure status=${body.status} reason=${reason} elapsed_ms=${Date.now() - startedAt}`,
  );
  return json(response, httpStatus, body);
}

/**
 * Лимит ожидания модели из окружения. Проверяется один раз при старте,
 * чтобы опечатка в конфиге не превращалась в 500 на каждом запросе.
 */
export function parseModelTimeoutMs(raw) {
  if (raw === undefined || raw.trim() === "") {
    return { ok: true, value: DEFAULT_MODEL_TIMEOUT_MS };
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    return {
      ok: false,
      message: `ожидалось целое число от 1 до 2147483647 мс, получено "${raw}"`,
    };
  }
  return { ok: true, value };
}

/** Граница №1: тело HTTP-запроса. */
function parseBody(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

/** Граница №2: поле text. Непустая строка — иначе модель не вызывается вообще. */
function validateText(payload) {
  const text = payload !== null && typeof payload === "object" ? payload.text : undefined;
  if (typeof text !== "string") return { ok: false, reason: "text_not_string" };
  if (text.trim() === "") return { ok: false, reason: "text_empty" };
  return { ok: true, value: text };
}

/** Граница №3: ответ модели. Проверяется строго, до показа менеджеру. */
function validateModelOutput(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "model_output_shape" };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "model_output_not_json" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "model_output_shape" };
  }
  const { topic, draft } = parsed;
  if (!ALLOWED_TOPICS.includes(topic)) return { ok: false, reason: "model_topic_unknown" };
  if (typeof draft !== "string" || draft.trim() === "") {
    return { ok: false, reason: "model_draft_empty" };
  }
  return { ok: true, value: { topic, draft } };
}

/**
 * Вызов модели с дедлайном. Модель просим остановиться через signal, но ответа не
 * ждём: гонка с таймером гарантирует ответ странице. Таймер снимается на любом
 * исходе, вызов обёрнут в промис, поэтому синхронное исключение модели — тоже сбой.
 */
async function callModel(classify, text, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("model deadline reached"));
    }, timeoutMs);
  });
  const call = Promise.resolve().then(() => classify(text, { signal: controller.signal }));
  // Проигравший в гонке не должен всплыть как unhandled rejection.
  call.catch(() => {});

  try {
    return { ok: true, value: await Promise.race([call, deadline]) };
  } catch {
    return { ok: false, reason: controller.signal.aborted ? "model_timeout" : "model_error" };
  } finally {
    clearTimeout(timer);
  }
}

/** Единственный путь разбора заявки: модель, валидация, затем ready или причина отказа. */
async function triage(text, { classify, modelTimeoutMs }) {
  const call = await callModel(classify, text, modelTimeoutMs);
  if (!call.ok) return { ok: false, reason: call.reason };

  const output = validateModelOutput(call.value);
  if (!output.ok) return { ok: false, reason: output.reason };

  const { topic, draft } = output.value;
  return { ok: true, value: { status: "ready", topic, draft } };
}

async function handleTriage(request, response, deps, startedAt) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);

  const body = parseBody(Buffer.concat(chunks).toString("utf8"));
  if (!body.ok) {
    return respondFailure(response, deps, 400, INVALID_INPUT_BODY, body.reason, startedAt);
  }

  const text = validateText(body.value);
  if (!text.ok) {
    return respondFailure(response, deps, 400, INVALID_INPUT_BODY, text.reason, startedAt);
  }

  const result = await triage(text.value, deps);
  if (!result.ok) {
    return respondFailure(response, deps, 200, MANUAL_REVIEW_BODY, result.reason, startedAt);
  }

  return json(response, 200, result.value);
}

export function createTriageServer({
  classify = mockClassify,
  modelTimeoutMs = DEFAULT_MODEL_TIMEOUT_MS,
  logger = console,
} = {}) {
  const deps = { classify, modelTimeoutMs, logger };

  return createServer(async (request, response) => {
    const asset = request.method === "GET" ? assets.get(request.url) : undefined;
    if (asset) {
      response.writeHead(200, { "Content-Type": asset.type });
      response.end(asset.body);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    const startedAt = Date.now();
    try {
      await handleTriage(request, response, deps, startedAt);
    } catch {
      const body = { status: "server_error" };
      respondFailure(response, deps, 500, body, "unhandled_exception", startedAt);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const timeout = parseModelTimeoutMs(process.env.MODEL_TIMEOUT_MS);
  if (!timeout.ok) {
    console.error(`MODEL_TIMEOUT_MS: ${timeout.message}`);
    process.exit(1);
  }

  const port = Number(process.env.PORT || 3000);
  createTriageServer({ modelTimeoutMs: timeout.value }).listen(port, "127.0.0.1", () => {
    console.log(`triage server: http://127.0.0.1:${port}`);
  });
}
