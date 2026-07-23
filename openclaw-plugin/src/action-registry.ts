import { Type } from "typebox";

import type { JsonObject, JsonValue } from "./result.js";

const MAX_BODY_CHARS = 262_144;
const MAX_ATTACHMENT_BASE64_CHARS = 1_400_000;
const MAX_SEND_CONTENT_BYTES = 1_048_576;
const ID_RE = /^[A-Za-z0-9._:-]+$/;
const MAILBOX_RE = /^[^\s@]+@[^\s@]+$/;
const EMAIL_RE =
  /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;
const ISO_DATE_TIME_WITH_OFFSET_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const ID_SCHEMA = Type.String({
  minLength: 1,
  maxLength: 255,
  pattern: "^[A-Za-z0-9._:-]+$",
});
const MESSAGE_ID_SCHEMA = Type.String({
  minLength: 8,
  maxLength: 128,
  pattern: "^[A-Za-z0-9._:-]+$",
});
const EMAIL_SCHEMA = Type.String({
  minLength: 3,
  maxLength: 254,
  format: "email",
});

const RESOLVE_MAILBOX_INPUT = Type.Object(
  {},
  { additionalProperties: false },
);
const LIST_MESSAGES_INPUT = Type.Object(
  {
    folder: Type.Optional(
      Type.String({ minLength: 1, maxLength: 128 }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 100 }),
    ),
    unseenOnly: Type.Optional(Type.Boolean()),
    from: Type.Optional(EMAIL_SCHEMA),
    subject: Type.Optional(Type.String({ maxLength: 256 })),
    since: Type.Optional(Type.String({ format: "date-time" })),
    beforeUid: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
const GET_MESSAGE_INPUT = Type.Object(
  {
    folder: Type.Optional(
      Type.String({ minLength: 1, maxLength: 128 }),
    ),
    uid: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
const ATTACHMENT_INPUT = Type.Object(
  {
    filename: Type.String({ minLength: 1, maxLength: 255 }),
    contentType: Type.String({ minLength: 1, maxLength: 127 }),
    contentBase64: Type.String({
      minLength: 1,
      maxLength: MAX_ATTACHMENT_BASE64_CHARS,
      pattern:
        "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
    }),
  },
  { additionalProperties: false },
);
const SEND_MAIL_INPUT = Type.Object(
  {
    idempotencyKey: MESSAGE_ID_SCHEMA,
    to: Type.Array(EMAIL_SCHEMA, { minItems: 1, maxItems: 50 }),
    cc: Type.Optional(Type.Array(EMAIL_SCHEMA, { maxItems: 50 })),
    bcc: Type.Optional(Type.Array(EMAIL_SCHEMA, { maxItems: 50 })),
    subject: Type.String({ maxLength: 998 }),
    text: Type.Optional(Type.String({ maxLength: MAX_BODY_CHARS })),
    html: Type.Optional(Type.String({ maxLength: MAX_BODY_CHARS })),
    attachments: Type.Optional(
      Type.Array(ATTACHMENT_INPUT, { maxItems: 10 }),
    ),
  },
  { additionalProperties: false },
);
const AMO_RECEIVER_INPUT = Type.Object(
  {
    id: ID_SCHEMA,
    name: Type.String({ minLength: 1, maxLength: 256 }),
    refId: Type.Optional(ID_SCHEMA),
  },
  { additionalProperties: false },
);
const SEND_AMO_CHAT_INPUT = Type.Object(
  {
    msgid: MESSAGE_ID_SCHEMA,
    conversationId: ID_SCHEMA,
    conversationRefId: Type.Optional(ID_SCHEMA),
    receiver: AMO_RECEIVER_INPUT,
    text: Type.String({ minLength: 1, maxLength: 32_768 }),
    silent: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const ACTION_NAMES = [
  "resolve-mailbox",
  "list-messages",
  "get-message",
  "send-message",
] as const;
const ACTION_NAME_SCHEMA = Type.Union(
  ACTION_NAMES.map((name) => Type.Literal(name)),
);

export const ACTION_PARAMETERS = Type.Object(
  {
    providerConfigKey: Type.Union([
      Type.Literal("yandex-mail"),
      Type.Literal("amocrm-chats"),
    ]),
    actionName: Type.Optional(ACTION_NAME_SCHEMA),
    action: Type.Optional(ACTION_NAME_SCHEMA),
    input: Type.Optional(
      Type.Union([
        RESOLVE_MAILBOX_INPUT,
        LIST_MESSAGES_INPUT,
        GET_MESSAGE_INPUT,
        SEND_MAIL_INPUT,
        SEND_AMO_CHAT_INPUT,
      ]),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 900_000 }),
    ),
  },
  { additionalProperties: false },
);

export type ActionOperationKind = "read" | "mutation";
export type PublicActionProvider = "yandex-mail" | "amocrm-chats";
export type PublicActionName = (typeof ACTION_NAMES)[number];

export type ActionRegistration = Readonly<{
  publicProviderConfigKey: PublicActionProvider;
  publicActionName: PublicActionName;
  internalProviderConfigKey: string;
  internalActionName: string;
  operationKind: ActionOperationKind;
  inputSchema: unknown;
  parseInput(value: unknown): JsonObject;
  validateSuccessResult(value: unknown): value is JsonValue;
}>;

function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    return false;
  }
  const keys = ownKeys as string[];
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key)) &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor !== undefined &&
        descriptor.enumerable &&
        Object.hasOwn(descriptor, "value")
      );
    })
  );
}

function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, required, optional)) {
    throw new Error("invalid_action_input");
  }
  return value;
}

function boundedString(
  value: unknown,
  minimum: number,
  maximum: number,
  trim = false,
): string {
  if (typeof value !== "string") {
    throw new Error("invalid_action_input");
  }
  const normalized = trim ? value.trim() : value;
  if (
    normalized.length < minimum ||
    normalized.length > maximum
  ) {
    throw new Error("invalid_action_input");
  }
  return normalized;
}

function optionalString(
  value: unknown,
  maximum: number,
): string | undefined {
  return value === undefined
    ? undefined
    : boundedString(value, 0, maximum);
}

function positiveInteger(value: unknown, maximum?: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (maximum !== undefined && (value as number) > maximum)
  ) {
    throw new Error("invalid_action_input");
  }
  return value as number;
}

function booleanDefault(value: unknown, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error("invalid_action_input");
  }
  return value;
}

function email(value: unknown): string {
  const parsed = boundedString(value, 3, 254);
  if (
    !EMAIL_RE.test(parsed) ||
    parsed.includes("..") ||
    parsed.indexOf("@") !== parsed.lastIndexOf("@")
  ) {
    throw new Error("invalid_action_input");
  }
  return parsed;
}

function emailArray(
  value: unknown,
  minimum: number,
  maximum: number,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    throw new Error("invalid_action_input");
  }
  return Object.freeze(value.map(email));
}

function optionalEmailArray(
  value: unknown,
): readonly string[] | undefined {
  return value === undefined ? undefined : emailArray(value, 0, 50);
}

function id(value: unknown, minimum = 1, maximum = 255): string {
  const parsed = boundedString(value, minimum, maximum);
  if (!ID_RE.test(parsed)) {
    throw new Error("invalid_action_input");
  }
  return parsed;
}

function parseResolveMailboxInput(value: unknown): JsonObject {
  if (value === undefined) {
    return Object.freeze({});
  }
  record(value, []);
  return Object.freeze({});
}

function parseListMessagesInput(value: unknown): JsonObject {
  const input = record(value, [], [
    "folder",
    "limit",
    "unseenOnly",
    "from",
    "subject",
    "since",
    "beforeUid",
  ]);
  const folder =
    input.folder === undefined
      ? "INBOX"
      : boundedString(input.folder, 1, 128, true);
  const limit =
    input.limit === undefined ? 25 : positiveInteger(input.limit, 100);
  const unseenOnly = booleanDefault(input.unseenOnly, false);
  const from = input.from === undefined ? undefined : email(input.from);
  const subject = optionalString(input.subject, 256);
  let since: string | undefined;
  if (input.since !== undefined) {
    since = boundedString(input.since, 1, 64);
    if (
      !ISO_DATE_TIME_WITH_OFFSET_RE.test(since) ||
      !Number.isFinite(Date.parse(since))
    ) {
      throw new Error("invalid_action_input");
    }
  }
  const beforeUid =
    input.beforeUid === undefined
      ? undefined
      : positiveInteger(input.beforeUid);
  return Object.freeze({
    folder,
    limit,
    unseenOnly,
    ...(from === undefined ? {} : { from }),
    ...(subject === undefined ? {} : { subject }),
    ...(since === undefined ? {} : { since }),
    ...(beforeUid === undefined ? {} : { beforeUid }),
  });
}

function parseGetMessageInput(value: unknown): JsonObject {
  const input = record(value, ["uid"], ["folder"]);
  return Object.freeze({
    folder:
      input.folder === undefined
        ? "INBOX"
        : boundedString(input.folder, 1, 128, true),
    uid: positiveInteger(input.uid),
  });
}

function parseAttachment(value: unknown): JsonObject {
  const input = record(value, [
    "filename",
    "contentType",
    "contentBase64",
  ]);
  const contentBase64 = boundedString(
    input.contentBase64,
    1,
    MAX_ATTACHMENT_BASE64_CHARS,
  );
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      contentBase64,
    ) ||
    Buffer.from(contentBase64, "base64").toString("base64") !==
      contentBase64
  ) {
    throw new Error("invalid_action_input");
  }
  return Object.freeze({
    filename: boundedString(input.filename, 1, 255, true),
    contentType: boundedString(input.contentType, 1, 127, true),
    contentBase64,
  });
}

function parseSendMailInput(value: unknown): JsonObject {
  const input = record(
    value,
    ["idempotencyKey", "to", "subject"],
    ["cc", "bcc", "text", "html", "attachments"],
  );
  const text = optionalString(input.text, MAX_BODY_CHARS);
  const html = optionalString(input.html, MAX_BODY_CHARS);
  if (text === undefined && html === undefined) {
    throw new Error("invalid_action_input");
  }
  let attachments: readonly JsonObject[] | undefined;
  if (input.attachments !== undefined) {
    if (
      !Array.isArray(input.attachments) ||
      input.attachments.length > 10
    ) {
      throw new Error("invalid_action_input");
    }
    attachments = Object.freeze(input.attachments.map(parseAttachment));
  }
  const contentBytes =
    Buffer.byteLength(text ?? "", "utf8") +
    Buffer.byteLength(html ?? "", "utf8") +
    (attachments ?? []).reduce(
      (total, attachment) =>
        total +
        Buffer.from(
          attachment.contentBase64 as string,
          "base64",
        ).byteLength,
      0,
    );
  if (contentBytes > MAX_SEND_CONTENT_BYTES) {
    throw new Error("invalid_action_input");
  }
  const cc = optionalEmailArray(input.cc);
  const bcc = optionalEmailArray(input.bcc);
  return Object.freeze({
    idempotencyKey: id(input.idempotencyKey, 8, 128),
    to: emailArray(input.to, 1, 50),
    ...(cc === undefined ? {} : { cc }),
    ...(bcc === undefined ? {} : { bcc }),
    subject: boundedString(input.subject, 0, 998),
    ...(text === undefined ? {} : { text }),
    ...(html === undefined ? {} : { html }),
    ...(attachments === undefined ? {} : { attachments }),
  });
}

function parseAmoReceiver(value: unknown): JsonObject {
  const input = record(value, ["id", "name"], ["refId"]);
  return Object.freeze({
    id: id(input.id),
    name: boundedString(input.name, 1, 256, true),
    ...(input.refId === undefined ? {} : { refId: id(input.refId) }),
  });
}

function parseSendAmoChatInput(value: unknown): JsonObject {
  const input = record(
    value,
    ["msgid", "conversationId", "receiver", "text"],
    ["conversationRefId", "silent"],
  );
  return Object.freeze({
    msgid: id(input.msgid, 8, 128),
    conversationId: id(input.conversationId),
    ...(input.conversationRefId === undefined
      ? {}
      : { conversationRefId: id(input.conversationRefId) }),
    receiver: parseAmoReceiver(input.receiver),
    text: boundedString(input.text, 1, 32_768),
    silent: booleanDefault(input.silent, false),
  });
}

function exactOutputRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  return (
    isPlainRecord(value) &&
    hasOnlyKeys(value, required, optional)
  );
}

function nullableBoundedString(value: unknown, maximum: number): boolean {
  return (
    value === null ||
    (typeof value === "string" && value.length <= maximum)
  );
}

function isMailbox(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 254 &&
    MAILBOX_RE.test(value) &&
    !value.includes("..") &&
    value.indexOf("@") === value.lastIndexOf("@")
  );
}

function isAddress(value: unknown): boolean {
  return (
    exactOutputRecord(value, ["name", "address"]) &&
    nullableBoundedString(value.name, 256) &&
    nullableBoundedString(value.address, 254)
  );
}

function isMessageSummary(value: unknown): boolean {
  return (
    exactOutputRecord(value, [
      "uid",
      "subject",
      "from",
      "to",
      "receivedAt",
      "flags",
      "size",
      "hasAttachments",
    ]) &&
    Number.isSafeInteger(value.uid) &&
    (value.uid as number) > 0 &&
    nullableBoundedString(value.subject, 998) &&
    Array.isArray(value.from) &&
    value.from.length <= 100 &&
    value.from.every(isAddress) &&
    Array.isArray(value.to) &&
    value.to.length <= 100 &&
    value.to.every(isAddress) &&
    (value.receivedAt === null ||
      (typeof value.receivedAt === "string" &&
        value.receivedAt.length <= 64 &&
        Number.isFinite(Date.parse(value.receivedAt)))) &&
    Array.isArray(value.flags) &&
    value.flags.length <= 100 &&
    value.flags.every(
      (flag) => typeof flag === "string" && flag.length <= 128,
    ) &&
    Number.isSafeInteger(value.size) &&
    (value.size as number) >= 0 &&
    typeof value.hasAttachments === "boolean"
  );
}

function isAttachmentMetadata(value: unknown): boolean {
  return (
    exactOutputRecord(value, [
      "filename",
      "contentType",
      "size",
      "contentId",
    ]) &&
    nullableBoundedString(value.filename, 255) &&
    typeof value.contentType === "string" &&
    value.contentType.length >= 1 &&
    value.contentType.length <= 127 &&
    Number.isSafeInteger(value.size) &&
    (value.size as number) >= 0 &&
    nullableBoundedString(value.contentId, 512)
  );
}

function validateResolveResult(value: unknown): value is JsonValue {
  return (
    exactOutputRecord(value, ["mailbox"]) &&
    isMailbox(value.mailbox)
  );
}

function validateListResult(value: unknown): value is JsonValue {
  return (
    exactOutputRecord(value, ["mailbox", "messages", "nextCursor"]) &&
    isMailbox(value.mailbox) &&
    Array.isArray(value.messages) &&
    value.messages.length <= 100 &&
    value.messages.every(isMessageSummary) &&
    (value.nextCursor === null ||
      (typeof value.nextCursor === "string" &&
        value.nextCursor.length <= 64))
  );
}

function validateGetResult(value: unknown): value is JsonValue {
  if (
    !exactOutputRecord(value, ["mailbox", "message"]) ||
    !isMailbox(value.mailbox) ||
    !exactOutputRecord(
      value.message,
      [
        "uid",
        "subject",
        "from",
        "to",
        "receivedAt",
        "flags",
        "size",
        "hasAttachments",
        "text",
        "html",
        "bodyTruncated",
        "attachments",
      ],
    ) ||
    !isMessageSummary(
      Object.fromEntries(
        Object.entries(value.message).filter(
          ([key]) =>
            !["text", "html", "bodyTruncated", "attachments"].includes(
              key,
            ),
        ),
      ),
    )
  ) {
    return false;
  }
  return (
    nullableBoundedString(value.message.text, MAX_BODY_CHARS) &&
    nullableBoundedString(value.message.html, MAX_BODY_CHARS) &&
    typeof value.message.bodyTruncated === "boolean" &&
    Array.isArray(value.message.attachments) &&
    value.message.attachments.length <= 100 &&
    value.message.attachments.every(isAttachmentMetadata)
  );
}

function validateSendMailResult(value: unknown): value is JsonValue {
  return (
    exactOutputRecord(value, ["mailbox", "messageId"]) &&
    isMailbox(value.mailbox) &&
    typeof value.messageId === "string" &&
    value.messageId.length >= 1 &&
    value.messageId.length <= 998
  );
}

function validateSendAmoResult(value: unknown): value is JsonValue {
  return (
    exactOutputRecord(value, [
      "conversationId",
      "senderId",
      "receiverId",
      "msgid",
      "refId",
    ]) &&
    typeof value.conversationId === "string" &&
    idOutput(value.conversationId, 1, 255) &&
    typeof value.senderId === "string" &&
    idOutput(value.senderId, 1, 255) &&
    (value.receiverId === null ||
      (typeof value.receiverId === "string" &&
        idOutput(value.receiverId, 1, 255))) &&
    typeof value.msgid === "string" &&
    value.msgid.length >= 1 &&
    value.msgid.length <= 255 &&
    typeof value.refId === "string" &&
    idOutput(value.refId, 8, 128)
  );
}

function idOutput(
  value: string,
  minimum: number,
  maximum: number,
): boolean {
  return (
    value.length >= minimum &&
    value.length <= maximum &&
    ID_RE.test(value)
  );
}

function registration(
  publicProviderConfigKey: PublicActionProvider,
  publicActionName: PublicActionName,
  operationKind: ActionOperationKind,
  inputSchema: unknown,
  parseInput: ActionRegistration["parseInput"],
  validateSuccessResult: ActionRegistration["validateSuccessResult"],
  internalProviderConfigKey: string = publicProviderConfigKey,
): ActionRegistration {
  return Object.freeze({
    publicProviderConfigKey,
    publicActionName,
    internalProviderConfigKey,
    internalActionName: publicActionName,
    operationKind,
    inputSchema,
    parseInput,
    validateSuccessResult,
  });
}

export const ACTION_REGISTRY: readonly ActionRegistration[] =
  Object.freeze([
    registration(
      "yandex-mail",
      "resolve-mailbox",
      "read",
      RESOLVE_MAILBOX_INPUT,
      parseResolveMailboxInput,
      validateResolveResult,
    ),
    registration(
      "yandex-mail",
      "list-messages",
      "read",
      LIST_MESSAGES_INPUT,
      parseListMessagesInput,
      validateListResult,
    ),
    registration(
      "yandex-mail",
      "get-message",
      "read",
      GET_MESSAGE_INPUT,
      parseGetMessageInput,
      validateGetResult,
    ),
    registration(
      "yandex-mail",
      "send-message",
      "mutation",
      SEND_MAIL_INPUT,
      parseSendMailInput,
      validateSendMailResult,
    ),
    registration(
      "amocrm-chats",
      "send-message",
      "mutation",
      SEND_AMO_CHAT_INPUT,
      parseSendAmoChatInput,
      validateSendAmoResult,
      "amocrm-chats-channel",
    ),
  ]);

const ACTION_LOOKUP = new Map(
  ACTION_REGISTRY.map((entry) => [
    `${entry.publicProviderConfigKey}\u0000${entry.publicActionName}`,
    entry,
  ]),
);

export function resolveActionRegistration(
  providerConfigKey: unknown,
  actionName: unknown,
): ActionRegistration | undefined {
  if (
    typeof providerConfigKey !== "string" ||
    typeof actionName !== "string"
  ) {
    return undefined;
  }
  return ACTION_LOOKUP.get(`${providerConfigKey}\u0000${actionName}`);
}
