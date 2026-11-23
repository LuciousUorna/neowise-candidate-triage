// Чистая презентационная логика страницы: ответ API → что показать менеджеру.
// Без DOM и без сети, поэтому проверяется обычным `node --test`.

const TOPIC_LABELS = {
  delivery: "Доставка",
  pricing: "Цены",
  other: "Другое",
};

const FALLBACK_MESSAGES = {
  manual_review: "Автоматический разбор не удался. Разберите заявку вручную.",
  invalid_input: "Проверьте текст заявки.",
  service_error: "Сервис ответил неожидаемым образом. Разберите заявку вручную.",
  network_error: "Сервис недоступен или не ответил. Разберите заявку вручную.",
};

function message(body, kind) {
  const own = body?.message;
  return typeof own === "string" && own.trim() !== "" ? own : FALLBACK_MESSAGES[kind];
}

/** Состояние «запрос ушёл»: черновик уже очищен, менеджер не видит старый текст. */
export function viewPending() {
  return { kind: "pending", title: "Разбираем заявку…", message: "", topic: "", draft: "" };
}

/** Сеть не ответила / запрос прерван по клиентскому таймауту. */
export function viewNetworkError() {
  return {
    kind: "network_error",
    title: "Нужен ручной разбор",
    message: FALLBACK_MESSAGES.network_error,
    topic: "",
    draft: "",
  };
}

/**
 * Единственное место, где решается, что показать по ответу API.
 * Черновик непустой ровно в одном случае — status "ready".
 */
export function viewForResponse(httpStatus, body) {
  if (httpStatus === 200 && body?.status === "ready") {
    return {
      kind: "ready",
      title: "Черновик готов",
      message: "Проверьте текст и решите, что отправить клиенту.",
      topic: TOPIC_LABELS[body.topic] ?? body.topic,
      draft: body.draft,
    };
  }
  if (httpStatus === 200 && body?.status === "manual_review") {
    return {
      kind: "manual_review",
      title: "Нужен ручной разбор",
      message: message(body, "manual_review"),
      topic: "",
      draft: "",
    };
  }
  if (httpStatus === 400 && body?.status === "invalid_input") {
    return {
      kind: "invalid_input",
      title: "Заявка не принята",
      message: message(body, "invalid_input"),
      topic: "",
      draft: "",
    };
  }
  return {
    kind: "service_error",
    title: "Нужен ручной разбор",
    message: message(body, "service_error"),
    topic: "",
    draft: "",
  };
}
