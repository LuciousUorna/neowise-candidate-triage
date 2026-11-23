import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";

export const ALLOWED_TOPICS = ["delivery", "pricing", "other"];
export const DEFAULT_MODEL_TIMEOUT_MS = 300;

// Человекочитаемые пояснения для менеджера: на странице показывается message,
// в логах и тестах используется машинный код reason.
const MESSAGES = {
  invalid_json: "Тело запроса не является корректным JSON.",
  text_not_string: "Поле text обязательно и должно быть строкой.",
  text_empty: "Текст заявки пустой.",
  model_timeout: "Модель не ответила за отведённое время.",
  model_error: "Модель вернула ошибку.",
  model_output_not_json: "Ответ модели не является JSON.",
  model_output_shape: "Ответ модели не соответствует ожидаемому формату.",
  model_topic_unknown: "Модель вернула недопустимую тему.",
  model_draft_empty: "Модель вернула пустой черновик.",
};

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

function invalidInput(reason) {
  return { status: "invalid_input", reason, message: MESSAGES[reason] };
}

function manualReview(reason) {
  return {
    status: "manual_review",
    topic: null,
    draft: null,
    reason,
    message: MESSAGES[reason],
  };
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
export function validateModelOutput(raw) {
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
 * Вызов модели с жёстким дедлайном: сначала просим модель остановиться через
 * signal, но ответ не ждём — гонка с таймаутом гарантирует ответ странице,
 * даже если модель проигнорирует отмену.
 */
async function callModel(classify, text, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  const deadline = new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("model deadline reached")), {
      once: true,
    });
  });
  const call = classify(text, { signal });
  // Проигравший в гонке не должен всплыть как unhandled rejection.
  Promise.resolve(call).catch(() => {});

  try {
    return { ok: true, value: await Promise.race([call, deadline]) };
  } catch (error) {
    return { ok: false, reason: signal.aborted ? "model_timeout" : "model_error", error };
  }
}

/** Единственный путь разбора заявки: модель → валидация → ready | manual_review. */
export async function triage(text, { classify, modelTimeoutMs }) {
  const call = await callModel(classify, text, modelTimeoutMs);
  if (!call.ok) return manualReview(call.reason);

  const output = validateModelOutput(call.value);
  if (!output.ok) return manualReview(output.reason);

  return { status: "ready", topic: output.value.topic, draft: output.value.draft };
}

async function handleTriage(request, response, deps) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);

  const body = parseBody(Buffer.concat(chunks).toString("utf8"));
  if (!body.ok) return json(response, 400, invalidInput(body.reason));

  const text = validateText(body.value);
  if (!text.ok) return json(response, 400, invalidInput(text.reason));

  return json(response, 200, await triage(text.value, deps));
}

export function createTriageServer({
  classify = mockClassify,
  modelTimeoutMs = Number(process.env.MODEL_TIMEOUT_MS || DEFAULT_MODEL_TIMEOUT_MS),
} = {}) {
  const deps = { classify, modelTimeoutMs };

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
    try {
      await handleTriage(request, response, deps);
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  createTriageServer().listen(port, "127.0.0.1", () => {
    console.log(`triage server: http://127.0.0.1:${port}`);
  });
}
