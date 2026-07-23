# Yandex Mail

- **Skill id:** `yandex-mail`
- **Nango provider_config_key:** `yandex-mail`
- **Family:** `yandex`
- **Scopes:** mail:imap_full, mail:smtp, login:email
- **Upstream base:** `https://login.yandex.ru (identity); mail via IMAP/SMTP`

## Examples

### Resolve mailbox email

```bash
python3 {baseDir}/scripts/nango_proxy.py call yandex-mail info --query 'format=json' --json-output
```

## Notes

The Python fallback resolves identity only. Mailbox reads and sends use registered Nango actions backed by the fixed IMAP/SMTP bridge; never expose the OAuth token.
