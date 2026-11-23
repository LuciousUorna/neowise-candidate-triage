import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { classify as mockClassify } from "./mock-ai.mjs";
import { createTriageServer, DEFAULT_MODEL_TIMEOUT_MS, parseModelTimeoutMs } from "./server.mjs";
import { viewForResponse, viewNetworkError, viewPending } from "./triage-ui.mjs";

const TEST_TIMEOUT_MS = 50; // тесты не ждут реальных секунд

const READY_DRAFT = "Спасибо за обращение. Уточним детали заявки.";
const INVALID_INPUT = { status: "invalid_input" };
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

/** Поднимает настоящий сервер на свободном порту и гасит его после теста. */
async function startServer(t, overrides = {}) {
  const calls = [];
  const logs = [];
  const classify = overrides.classify ?? ((text, options) => mockClassify(text, options));
  const server = createTriageServer({
    modelTimeoutMs: TEST_TIMEOUT_MS,
    logger: { warn: (line) => logs.push(line) },
    ...overrides,
    classify: (text, options) => {
      calls.push(text);
      return classify(text, options);
    },
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  return { calls, logs, origin: `http://127.0.0.1:${port}` };
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

/** Причина отказа видна только в логе сервера, в ответе её нет. */
function assertLoggedFailure(logs, status, reason) {
  assert.equal(logs.length, 1, "на один отказ ожидается ровно одна строка лога");
  assert.match(
    logs[0],
    new RegExp(`^triage_failure status=${status} reason=${reason} elapsed_ms=\\d+$`),
  );
}

describe("POST /api/triage: проверка ввода, модель не вызывается", () => {
  const cases = [
    ["пустая строка", JSON.stringify({ text: "" }), "text_empty"],
    ["только пробелы", JSON.stringify({ text: "   \n\t " }), "text_empty"],
    ["поля text нет", JSON.stringify({}), "text_not_string"],
    ["нестроковый text", JSON.stringify({ text: 42 }), "text_not_string"],
    ["битый JSON в теле", "{ text: ", "invalid_json"],
  ];

  for (const [name, body, reason] of cases) {
    it(`${name}: 400 invalid_input, в логе ${reason}`, async (t) => {
      const { origin, calls, logs } = await startServer(t);
      const reply = await postRaw(origin, body);

      assert.equal(reply.status, 400);
      assert.deepStrictEqual(reply.body, INVALID_INPUT);
      assert.deepStrictEqual(calls, []);
      assertLoggedFailure(logs, "invalid_input", reason);
    });
  }
});

describe("POST /api/triage: сбои модели дают manual_review без черновика", () => {
  const expectManualReview = ({ status, body }, logs, reason) => {
    assert.equal(status, 200);
    assert.deepStrictEqual(body, MANUAL_REVIEW);
    assertLoggedFailure(logs, "manual_review", reason);
  };

  it("модель молчит дольше дедлайна: model_timeout, ответ не ждёт модель", async (t) => {
    // Модель игнорирует signal: дедлайн всё равно обязан сработать.
    const { origin, logs } = await startServer(t, {
      classify: () => delay(5_000, "{}", { ref: false }),
    });

    const started = Date.now();
    const reply = await postRaw(origin, JSON.stringify({ text: "любой текст" }));
    const elapsed = Date.now() - started;

    expectManualReview(reply, logs, "model_timeout");
    assert.ok(elapsed < 2_000, `ответ пришёл за ${elapsed} мс, ожидался близкий к дедлайну`);
  });

  it("модель бросает исключение синхронно: model_error, а не 500", async (t) => {
    const { origin, logs } = await startServer(t, {
      classify: () => {
        throw new Error("provider misconfigured");
      },
    });

    expectManualReview(await postText(origin, "любой текст"), logs, "model_error");
  });

  it("синхронное исключение модели не оставляет unhandled rejection", async (t) => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    t.after(() => process.off("unhandledRejection", onUnhandled));

    const { origin } = await startServer(t, {
      classify: () => {
        throw new Error("provider misconfigured");
      },
    });
    await postText(origin, "любой текст");

    // Ждём дольше дедлайна: снятый таймер не должен отвалиться позже.
    await delay(TEST_TIMEOUT_MS * 4);
    assert.deepStrictEqual(unhandled, []);
  });

  const mockFailures = [
    ["[timeout]", "model_timeout"],
    ["[error]", "model_error"],
    ["[bad-json]", "model_output_not_json"],
    ["[bad-topic]", "model_topic_unknown"],
    ["[empty-draft]", "model_draft_empty"],
  ];

  for (const [label, reason] of mockFailures) {
    it(`имитатор с ${label}: в логе ${reason}`, async (t) => {
      const { origin, logs } = await startServer(t);
      expectManualReview(await postText(origin, `заявка ${label}`), logs, reason);
    });
  }

  it("ответ модели не объект: model_output_shape", async (t) => {
    const { origin, logs } = await startServer(t, {
      classify: async () => JSON.stringify([1, 2]),
    });
    expectManualReview(await postText(origin, "любой текст"), logs, "model_output_shape");
  });

  it("в ответе модели нет draft: model_draft_empty", async (t) => {
    const { origin, logs } = await startServer(t, {
      classify: async () => JSON.stringify({ topic: "other" }),
    });
    expectManualReview(await postText(origin, "любой текст"), logs, "model_draft_empty");
  });
});

describe("POST /api/triage: успешный разбор", () => {
  it("обычная заявка про доставку: 200 ready с темой и черновиком", async (t) => {
    const { origin, logs } = await startServer(t);
    const { status, body } = await postText(origin, "Когда будет доставка заказа?");

    assert.equal(status, 200);
    assert.deepStrictEqual(body, { status: "ready", topic: "delivery", draft: READY_DRAFT });
    assert.deepStrictEqual(logs, [], "успех не пишется в лог отказов");
  });

  it("заявка про цену: тема pricing", async (t) => {
    const { origin } = await startServer(t);
    const { body } = await postText(origin, "Сколько стоимость подключения?");

    assert.deepStrictEqual(body, { status: "ready", topic: "pricing", draft: READY_DRAFT });
  });
});

describe("Лимит ожидания модели из MODEL_TIMEOUT_MS", () => {
  it("по умолчанию 300 мс, как в задании", () => {
    assert.equal(DEFAULT_MODEL_TIMEOUT_MS, 300);
    assert.deepStrictEqual(parseModelTimeoutMs(undefined), { ok: true, value: 300 });
    assert.deepStrictEqual(parseModelTimeoutMs(" "), { ok: true, value: 300 });
  });

  it("целое положительное значение принимается", () => {
    assert.deepStrictEqual(parseModelTimeoutMs("150"), { ok: true, value: 150 });
  });

  for (const raw of ["abc", "0", "-1", "1.5", "300ms", "9999999999"]) {
    it(`значение "${raw}" отклоняется с понятным сообщением`, () => {
      const result = parseModelTimeoutMs(raw);

      assert.equal(result.ok, false);
      assert.match(result.message, /целое число от 1 до 2147483647/);
      assert.ok(result.message.includes(raw));
    });
  }
});

describe("Маршрутизация", () => {
  it("GET / отдаёт страницу", async (t) => {
    const { origin } = await startServer(t);
    const reply = await fetch(origin);

    assert.equal(reply.status, 200);
    assert.match(reply.headers.get("content-type"), /text\/html/);
    assert.match(await reply.text(), /Входящие заявки/);
  });

  it("неизвестный маршрут: 404 not_found", async (t) => {
    const { origin } = await startServer(t);
    const reply = await fetch(`${origin}/api/unknown`, { method: "POST" });

    assert.equal(reply.status, 404);
    assert.deepStrictEqual(await reply.json(), { status: "not_found" });
  });
});

describe("Логика страницы: черновик очищается при любом сбое", () => {
  const failures = [
    ["manual_review", 200, MANUAL_REVIEW],
    ["invalid_input", 400, INVALID_INPUT],
    ["server_error", 500, { status: "server_error" }],
  ];

  for (const [name, httpStatus, body] of failures) {
    it(`${name}: черновик пустой, менеджер видит понятный текст`, () => {
      const view = viewForResponse(httpStatus, body);

      assert.equal(view.draft, "");
      assert.equal(view.topic, "");
      assert.ok(view.title.length > 0);
      assert.ok(view.message.length > 0);
    });
  }

  it("manual_review показывает «нужен ручной разбор»", () => {
    const view = viewForResponse(200, MANUAL_REVIEW);

    assert.equal(view.kind, "manual_review");
    assert.match(view.title.toLowerCase(), /ручной разбор/);
    assert.match(view.message, /вручную/);
  });

  it("недоступная сеть и начало нового запроса тоже очищают черновик", () => {
    assert.equal(viewNetworkError().draft, "");
    assert.equal(viewPending().draft, "");
  });

  it("ready показывает тему и черновик", () => {
    const body = { status: "ready", topic: "delivery", draft: "Текст ответа" };
    const view = viewForResponse(200, body);

    assert.equal(view.kind, "ready");
    assert.equal(view.topic, "Доставка");
    assert.equal(view.draft, "Текст ответа");
  });
});
