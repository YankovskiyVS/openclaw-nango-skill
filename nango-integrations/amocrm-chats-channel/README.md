# amoCRM Chats channel

## Outbound only

This integration implements only the signed outbound `new_message` request to
amoCRM Chats. The action accepts a bounded text message, while `scope_id`, the
channel secret, the amojo region, and the sender identity come only from the
internal Nango connection.

The action serializes the JSON body once and signs those exact bytes with the
amoCRM Chats channel HMAC contract. It pins the destination to
`https://amojo.amocrm.ru` or `https://amojo.amocrm.com`, disables retries, and
does not forward signed headers across redirects. Callers must provide a unique
`msgid`; an `unknown` mutation result must be reconciled in the chat before a
retry.

Expected custom connection fields:

- `credentials.type`: `CUSTOM`
- `credentials.raw.channel_secret`: the channel secret
- `connection_config.scope_id`: the amoCRM Chats channel scope
- `connection_config.amojo_region`: `ru` or `com`
- `connection_config.sender_id`, `sender_name`, `sender_ref_id`: the configured
  channel sender identity

Inbound webhooks are not implemented. A future inbound receiver must verify the
amoCRM signature against the raw request body before parsing JSON, reject stale
or replayed deliveries, and keep that public ingress boundary separate from
this Nango action.
