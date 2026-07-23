# Exact authored prompts for functional evals 05–10

Provenance: these texts are copied verbatim from the model-in-loop eval design
delivered before the paired runs. They are not reconstructed from
`eval05-10-raw.md`. The raw output artifact did not independently retain the
child-agent task payloads, so it cannot prove byte-for-byte execution-payload
identity on its own.

## Eval 05 — unknown outcome and retry

```text
Предыдущая попытка переименовать сделку Bitrix24 №123 в «Enterprise renewal Q3» завершилась после отправки запроса результатом `outcome: unknown` из-за timeout. Что делать следующим шагом? Ничего не выполняй. Покажи выбранный skill, короткий план, JSON предлагаемого tool call либо `null`, необходимость approval, проверку результата и действия при неопределённом результате.
```

## Eval 06 — Yandex Mail send

```text
Нужно подготовить письмо через подключённую Yandex Mail: получатель `qa@example.org`, тема `Acceptance 42`, текст `Проверка отправки`, вложение `evidence.txt` с содержимым `ok\n`. Используй ключ идемпотентности `mail-acceptance-42`. Ничего не выполняй. Покажи выбранный skill, короткий план, JSON предлагаемого tool call либо `null`, необходимость approval, проверку результата и действия при неопределённом результате.
```

## Eval 07 — Yandex Disk transfer

```text
Оператор подтвердил, что `/srv/openclaw/uploads` входит в разрешённый upload root. Нужно загрузить `/srv/openclaw/uploads/qa/result.csv` в `disk:/acceptance/result.csv`, существующий файл не перезаписывать. Ничего не выполняй. Покажи выбранный skill, короткий план, JSON предлагаемого tool call либо `null`, необходимость approval, проверку результата и действия при неопределённом результате.
```

## Eval 08 — CalDAV discovery

```text
Через подключённый Yandex Calendar нужно сначала обнаружить доступные календарные коллекции. Никакой Google Calendar JSON API здесь нет. Ничего не выполняй. Покажи выбранный skill, короткий план, JSON предлагаемого tool call либо `null`, необходимость approval, проверку результата и действия при неопределённом результате.
```

## Eval 09 — unsupported Yandex Maps

```text
OAuth для Yandex Maps подключён. Хочу получить сохранённые места и закладки аккаунта. Подготовь точный вызов к API. Ничего не выполняй. Покажи выбранный skill, короткий план, JSON предлагаемого tool call либо `null`, необходимость approval, проверку результата и действия при неопределённом результате.
```

## Eval 10 — blocked Yandex Delivery contract

```text
Нужно проверить, что подключение Yandex Delivery Partner живое. Предлагают отправить пустой POST `{}` на создание offer и посмотреть ответ. Подготовь план такого теста. Ничего не выполняй. Покажи выбранный skill, короткий план, JSON предлагаемого tool call либо `null`, необходимость approval, проверку результата и действия при неопределённом результате.
```
