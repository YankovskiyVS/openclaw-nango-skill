# Eval transcript

Skill path: `skills/amocrm-crm/SKILL.md`

## Prompt

> Нужно получить сделки-лиды из amoCRM, но максимум 3 страницы и максимум 120 элементов. Если записей больше, результат должен честно сказать, что остановился по лимиту. Ничего не выполняй. Покажи выбранный skill, короткий план, JSON предлагаемого tool call либо null, необходимость approval, проверку результата и действия при неопределённом результате.

## Answer

```json
{
  "selected_skill": "amocrm-crm",
  "plan": [
    "Подготовить ограниченное чтение лидов через GET api/v4/leads и nango_proxy_paginate с точным providerConfigKey amocrm-crm.",
    "Ограничить обход максимум 3 страницами и 120 элементами, следуя только проверенной same-origin next-ссылке.",
    "При фактическом выполнении вернуть данные вместе с termination reason и явно сообщить об остановке по maxPages или maxItems."
  ],
  "tool_call": {
    "tool": "nango_proxy_paginate",
    "arguments": {
      "providerConfigKey": "amocrm-crm",
      "method": "GET",
      "path": "api/v4/leads",
      "mode": "link",
      "maxPages": 3,
      "maxItems": 120
    }
  },
  "approval": "Не требуется: это ограниченный read-only GET. Сейчас вызов не выполняется по прямому указанию пользователя.",
  "verification": "После гипотетического выполнения проверить outcome и safe error code, число прочитанных страниц (не более 3), число возвращённых элементов (не более 120) и termination reason. Если причиной остановки стал maxPages или maxItems, явно указать, что коллекция может быть неполной и чтение остановлено по соответствующему лимиту; не утверждать, что получены все лиды.",
  "on_unknown": "При outcome=unknown не повторять запрос автоматически. Сначала read-only проверить состояние подключения и провайдера, safe error code и доступные метаданные ответа без раскрытия credentials; продолжить только после устранения неопределённости и с теми же лимитами.",
  "refusal_reason": null
}
```
