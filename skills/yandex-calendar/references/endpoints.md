# Yandex Calendar

- **Skill id:** `yandex-calendar`
- **Nango provider_config_key:** `yandex-calendar`
- **Family:** `yandex`
- **Scopes:** calendar:all
- **Upstream base:** `https://caldav.yandex.ru`

## Operations

### CalDAV root

- **Operation name:** `CalDAV root`
- **Availability:** `ready`
- **Method:** `PROPFIND`
- **Path:** `calendars/`
- **Request shape:** method and relative path, bounded `headers`, `textBody`, explicit `contentType`; see the exact typed arguments below.
- **Pagination:** `single`: one response, `maxPages=1`, `maxItems=500`. For CalDAV the XML body is one item, so maxItems is not an event count.
- **Mutability:** `read` — no mutation approval.
- **Verification:** Return one bounded raw-XML response and the byte/page termination reason. Do not treat maxItems as a calendar count or infer collection paths from undocumented shapes.
- **Authoritative docs:** `not_verified` — no authoritative documentation URL is recorded for this operation.

#### Typed tool call

```json
{
  "tool": "nango_proxy_paginate",
  "arguments": {
    "providerConfigKey": "yandex-calendar",
    "method": "PROPFIND",
    "path": "calendars/",
    "headers": {
      "Depth": "1"
    },
    "textBody": "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:displayname/></d:prop></d:propfind>",
    "contentType": "application/xml; charset=utf-8",
    "mode": "single",
    "maxPages": 1,
    "maxItems": 500
  }
}
```

### Query events (replace documented CalDAV fields)

- **Operation name:** `Query events (replace documented CalDAV fields)`
- **Availability:** `template`
- **Method:** `REPORT`
- **Path:** `calendars/REPLACE_WITH_DISCOVERED_COLLECTION/`
- **Request shape:** method and relative path, bounded `headers`, `textBody`, explicit `contentType`; see the exact typed arguments below.
- **Pagination:** `single`: one response, `maxPages=1`, `maxItems=500`. For CalDAV the XML body is one item, so maxItems is not an event count.
- **Mutability:** `read` — no mutation approval.
- **Verification:** Before execution replace the collection, Depth, and XML with documented values including a bounded time range. Return one raw-XML response; maxItems does not count events.
- **Authoritative docs:** `not_verified` — no authoritative documentation URL is recorded for this operation.

This is a **non-executable template**. Replace every `REPLACE_WITH_...` value with a confirmed value inside the configured runtime boundary before execution.

#### Typed tool call

```json
{
  "tool": "nango_proxy_paginate",
  "arguments": {
    "providerConfigKey": "yandex-calendar",
    "method": "REPORT",
    "path": "calendars/REPLACE_WITH_DISCOVERED_COLLECTION/",
    "headers": {
      "Depth": "REPLACE_WITH_DOCUMENTED_DEPTH"
    },
    "textBody": "REPLACE_WITH_DOCUMENTED_BOUNDED_CALDAV_REPORT_XML",
    "contentType": "application/xml; charset=utf-8",
    "mode": "single",
    "maxPages": 1,
    "maxItems": 500
  }
}
```

### Create event resource (replace documented CalDAV fields)

- **Operation name:** `Create event resource (replace documented CalDAV fields)`
- **Availability:** `template`
- **Method:** `PUT`
- **Path:** `calendars/REPLACE_WITH_DISCOVERED_COLLECTION/REPLACE_WITH_EVENT_NAME.ics`
- **Request shape:** method and relative path, `textBody`, explicit `contentType`; see the exact typed arguments below.
- **Pagination:** None — one bounded tool call.
- **Mutability:** `mutation` — one-time approval is required before execution.
- **Verification:** After success or unknown, GET the same event path and compare the body and safe ETag. Without an ETag, report verification as incomplete.
- **Authoritative docs:** `not_verified` — no authoritative documentation URL is recorded for this operation.

This is a **non-executable template**. Replace every `REPLACE_WITH_...` value with a confirmed value inside the configured runtime boundary before execution.

#### Typed tool call

```json
{
  "tool": "nango_proxy_request",
  "arguments": {
    "providerConfigKey": "yandex-calendar",
    "method": "PUT",
    "path": "calendars/REPLACE_WITH_DISCOVERED_COLLECTION/REPLACE_WITH_EVENT_NAME.ics",
    "textBody": "REPLACE_WITH_COMPLETE_VCALENDAR_ICS",
    "contentType": "text/calendar; charset=utf-8"
  }
}
```

## Notes

CalDAV (ICS), not Google Calendar JSON API.
