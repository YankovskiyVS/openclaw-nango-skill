Skill: skills/yandex-id/SKILL.md

Prompt: «В OpenClaw подключён мой Yandex ID через Nango. Нужно получить профиль: логин, email и доступные данные аккаунта. Ничего не выполняй. Покажи выбранный skill, короткий план, JSON предлагаемого tool call либо null, необходимость approval, проверку результата и действия при неопределённом результате.»

{
  "selected_skill": "yandex-id",
  "plan": [
    "Использовать точный Nango providerConfigKey yandex-id и предложить один read-only запрос GET info?format=json.",
    "При возможном последующем выполнении вернуть логин, email и остальные поля профиля только из подтверждённого ответа; сейчас ничего не вызывать."
  ],
  "tool_call": {
    "tool": "nango_proxy_request",
    "arguments": {
      "providerConfigKey": "yandex-id",
      "method": "GET",
      "path": "info",
      "query": [
        {
          "name": "format",
          "value": "json"
        }
      ]
    }
  },
  "approval": "Не требуется: это read-only GET. По текущему указанию вызов только предложен и не выполняется.",
  "verification": "При фактическом выполнении принять данные только при outcome=confirmed и проверить, что ответ содержит профиль; извлечь login, email и прочие реально возвращённые поля, не додумывая отсутствующие. HTTP-статус сам по себе не определяет слой ошибки.",
  "on_unknown": "При outcome=unknown не повторять вызов вслепую: проверить состояние подключения Yandex ID/Nango и доступность профиля; не считать данные полученными, пока проверочное чтение не даст outcome=confirmed. Сообщать только safe error code и outcome, без раскрытия credentials.",
  "refusal_reason": null
}
