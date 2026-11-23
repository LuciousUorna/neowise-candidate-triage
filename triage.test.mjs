import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { classify as mockClassify } from "./mock-ai.mjs";
import { createTriageServer } from "./server.mjs";
import { viewForResponse, viewNetworkError, viewPending } from "./triage-ui.mjs";

const TEST_TIMEOUT_MS = 50; // тесты не ждут реальных секунд

/** Поднимает настоящий сервер на свободном порту и гасит его после теста. */
async function startServer(t, overrides = {}) {
  const calls = [];
  const classify = overrides.classify ?? ((text, options) => mockClassify(text, options));
  const server = createTriageServer({
    modelTimeoutMs: TEST_TIMEOUT_MS,
    ...overrides,
    classify: (text, options) => {
      calls.push(text);
      return classify(text, options);
    },
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  return { calls, origin: `http://127.0.0.1:${port}` };
}

async function postRaw(origin, body) {
  const reply = await fetch(`${origin}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return { status: reply.status, body: await reply.json() };
}

const postText = (origin, text) => postRaw(origin, JSON.stringify({ text }));

describe("POST /api/triage — проверка ввода (модель не вызывается)", () => {
  it("пустая строка → 400 invalid_input", async (t) => {
    const { origin, calls } = await startServer(t);
    const { status, body } = await postText(origin, "");

    assert.equal(status, 400);
    assert.equal(body.status, "invalid_input");
    assert.equal(body.reason, "text_empty");
    assert.deepEqual(calls, []);
  });

  it("только пробелы → 400 invalid_input", async (t) => {
    const { origin, calls } = await startServer(t);
    const { status, body } = await postText(origin, "   \n\t ");

    assert.equal(status, 400);
    assert.equal(body.reason, "text_empty");
    assert.deepEqual(calls, []);
  });

  it("поле text отсутствует → 400 invalid_input", async (t) => {
    const { origin, calls } = await startServer(t);
    const { status, body } = await postRaw(origin, JSON.stringify({}));

    assert.equal(status, 400);
    assert.equal(body.reason, "text_not_string");
    assert.deepEqual(calls, []);
  });

  it("нестроковый text → 400 invalid_input", async (t) => {
    const { origin, calls } = await startServer(t);
    const { status, body } = await postRaw(origin, JSON.stringify({ text: 42 }));

    assert.equal(status, 400);
    assert.equal(body.reason, "text_not_string");
    assert.deepEqual(calls, []);
  });

  it("битый JSON в теле → 400 invalid_input", async (t) => {
    const { origin, calls } = await startServer(t);
    const { status, body } = await postRaw(origin, "{ text: ");

    assert.equal(status, 400);
    assert.equal(body.reason, "invalid_json");
    assert.deepEqual(calls, []);
  });
});

describe("POST /api/triage — сбои модели дают manual_review без черновика", () => {
  const expectManualReview = ({ status, body }, reason) => {
    assert.equal(status, 200);
    assert.equal(body.status, "manual_review");
    assert.equal(body.reason, reason);
    assert.equal(body.topic, null);
    assert.equal(body.draft, null);
    assert.ok(body.message.length > 0, "менеджер должен получить причину текстом");
  };

  it("модель молчит дольше дедлайна → model_timeout, ответ не ждёт модель", async (t) => {
    // Модель игнорирует signal — дедлайн всё равно обязан сработать.
    const { origin } = await startServer(t, { classify: () => delay(5_000, "{}", { ref: false }) });

    const started = Date.now();
    const reply = await postRaw(origin, JSON.stringify({ text: "любой текст" }));
    const elapsed = Date.now() - started;

    expectManualReview(reply, "model_timeout");
    assert.ok(elapsed < 2_000, `ответ пришёл за ${elapsed} мс, ожидался близкий к дедлайну`);
  });

  it("имитатор с [timeout] → model_timeout", async (t) => {
    const { origin } = await startServer(t);
    expectManualReview(await postText(origin, "заявка [timeout]"), "model_timeout");
  });

  it("имитатор с [error] → model_error", async (t) => {
    const { origin } = await startServer(t);
    expectManualReview(await postText(origin, "заявка [error]"), "model_error");
  });

  it("имитатор с [bad-json] → model_output_not_json", async (t) => {
    const { origin } = await startServer(t);
    expectManualReview(await postText(origin, "заявка [bad-json]"), "model_output_not_json");
  });

  it("имитатор с [bad-topic] → model_topic_unknown", async (t) => {
    const { origin } = await startServer(t);
    expectManualReview(await postText(origin, "заявка [bad-topic]"), "model_topic_unknown");
  });

  it("имитатор с [empty-draft] → model_draft_empty", async (t) => {
    const { origin } = await startServer(t);
    expectManualReview(await postText(origin, "заявка [empty-draft]"), "model_draft_empty");
  });

  it("ответ модели не объект → model_output_shape", async (t) => {
    const { origin } = await startServer(t, { classify: async () => JSON.stringify([1, 2]) });
    expectManualReview(await postText(origin, "любой текст"), "model_output_shape");
  });

  it("в ответе модели нет draft → model_draft_empty", async (t) => {
    const { origin } = await startServer(t, { classify: async () => JSON.stringify({ topic: "other" }) });
    expectManualReview(await postText(origin, "любой текст"), "model_draft_empty");
  });
});

describe("POST /api/triage — успешный разбор", () => {
  it("обычная заявка про доставку → 200 ready с темой и черновиком", async (t) => {
    const { origin } = await startServer(t);
    const { status, body } = await postText(origin, "Когда будет доставка заказа?");

    assert.equal(status, 200);
    assert.equal(body.status, "ready");
    assert.equal(body.topic, "delivery");
    assert.equal(body.draft, "Спасибо за обращение. Уточним детали заявки.");
  });

  it("заявка про цену → тема pricing", async (t) => {
    const { origin } = await startServer(t);
    const { body } = await postText(origin, "Сколько стоимость подключения?");

    assert.equal(body.status, "ready");
    assert.equal(body.topic, "pricing");
  });
});

describe("Маршрутизация", () => {
  it("GET / отдаёт страницу", async (t) => {
    const { origin } = await startServer(t);
    const reply = await fetch(origin);

    assert.equal(reply.status, 200);
    assert.match(reply.headers.get("content-type"), /text\/html/);
    assert.match(await reply.text(), /Входящие заявки/);
  });

  it("неизвестный маршрут → 404 not_found", async (t) => {
    const { origin } = await startServer(t);
    const reply = await fetch(`${origin}/api/unknown`, { method: "POST" });

    assert.equal(reply.status, 404);
    assert.equal((await reply.json()).status, "not_found");
  });
});

describe("Логика страницы: черновик очищается при любом сбое", () => {
  const failures = [
    ["manual_review", 200, { status: "manual_review", topic: null, draft: null, reason: "model_timeout", message: "Модель не ответила за отведённое время." }],
    ["invalid_input", 400, { status: "invalid_input", reason: "text_empty", message: "Текст заявки пустой." }],
    ["server_error", 500, { status: "server_error" }],
  ];

  for (const [name, httpStatus, body] of failures) {
    it(`${name} → черновик пустой, менеджер видит причину`, () => {
      const view = viewForResponse(httpStatus, body);

      assert.equal(view.draft, "");
      assert.equal(view.topic, "");
      assert.ok(view.title.length > 0);
      assert.ok(view.message.length > 0);
    });
  }

  it("manual_review показывает «нужен ручной разбор»", () => {
    const view = viewForResponse(200, { status: "manual_review", reason: "model_error", message: "Модель вернула ошибку." });

    assert.equal(view.kind, "manual_review");
    assert.match(view.title.toLowerCase(), /ручной разбор/);
    assert.equal(view.message, "Модель вернула ошибку.");
  });

  it("недоступная сеть и начало нового запроса тоже очищают черновик", () => {
    assert.equal(viewNetworkError().draft, "");
    assert.equal(viewPending().draft, "");
  });

  it("ready показывает тему и черновик", () => {
    const view = viewForResponse(200, { status: "ready", topic: "delivery", draft: "Текст ответа" });

    assert.equal(view.kind, "ready");
    assert.equal(view.topic, "Доставка");
    assert.equal(view.draft, "Текст ответа");
  });
});
