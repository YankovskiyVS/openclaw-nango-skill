Skill: git:12903d917509fab4a4da4d7dd0489a42c00286e6:skills/yandex-id/SKILL.md

Исходный prompt:

«В OpenClaw подключён мой Yandex ID через Nango. Нужно получить профиль: логин, email и доступные данные аккаунта. Ничего не выполняй. Покажи выбранный skill, короткий план, JSON предлагаемого tool call либо null, необходимость approval, проверку результата и действия при неопределённом результате.»

{
  "selected_skill": "yandex-id",
  "plan": [
    "Использовать подключение Nango с provider_config_key yandex-id и запросить профиль Yandex ID через endpoint info в формате JSON.",
    "До отдельного явного разрешения не выполнять вызов и не читать или показывать ключи и OAuth-токены.",
    "После разрешения проверить ответ и вернуть login, email и только те остальные поля аккаунта, которые фактически присутствуют в ответе."
  ],
  "tool_call": {
    "tool": "exec",
    "arguments": {
      "command": "python3 {baseDir}/scripts/nango_proxy.py call yandex-id info --query 'format=json' --json-output"
    }
  },
  "approval": "Требуется отдельное явное approval перед выполнением: запрос является чтением профиля, но пользователь прямо указал «Ничего не выполняй». Сейчас это только предложение вызова.",
  "verification": "После одобрения проверить успешное завершение команды, HTTP 2xx и валидный JSON; извлечь login, фактически возвращённые email-поля и все остальные доступные поля профиля, не раскрывая CLOUDRU_API_KEY, OAuth-токены или Nango secret.",
  "on_unknown": "Не угадывать и не считать отсутствующие поля подтверждёнными. Остановиться и безопасно сообщить статус и неполный или неоднозначный ответ: при 401 указать на API key или IAM, при 404 — на EVOCLAW_ID или project, при upstream 4xx/5xx попросить переподключить yandex-id в Cloud.ru; не переключаться на legacy key yandex без подтверждения.",
  "refusal_reason": null
}
