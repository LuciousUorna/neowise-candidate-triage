// Чистая презентационная логика страницы: по ответу API решаем, что увидит менеджер.
// Без DOM и без сети, поэтому проверяется обычным `node --test`.

const TOPIC_LABELS = {
  delivery: "Доставка",
  pricing: "Цены",
  other: "Другое",
};

// Текст для менеджера живёт здесь: API возвращает только статус.
const MESSAGES = {
  manual_review: "Автоматический разбор не удался. Разберите заявку вручную.",
  invalid_input: "Текст заявки пустой или не распознан. Проверьте и отправьте снова.",
  service_error: "Сервис ответил неожидаемым образом. Разберите заявку вручную.",
  network_error: "Сервис недоступен или не ответил. Разберите заявку вручную.",
};

/** Состояние «запрос ушёл»: черновик уже очищен, менеджер не видит старый текст. */
export function viewPending() {
  return { kind: "pending", title: "Разбираем заявку…", message: "", topic: "", draft: "" };
}

/** Сеть не ответила / запрос прерван по клиентскому таймауту. */
export function viewNetworkError() {
  return {
    kind: "network_error",
    title: "Нужен ручной разбор",
    message: MESSAGES.network_error,
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
      message: MESSAGES.manual_review,
      topic: "",
      draft: "",
    };
  }
  if (httpStatus === 400 && body?.status === "invalid_input") {
    return {
      kind: "invalid_input",
      title: "Заявка не принята",
      message: MESSAGES.invalid_input,
      topic: "",
      draft: "",
    };
  }
  return {
    kind: "service_error",
    title: "Нужен ручной разбор",
    message: MESSAGES.service_error,
    topic: "",
    draft: "",
  };
}
