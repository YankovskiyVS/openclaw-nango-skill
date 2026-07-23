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

HTTP proxy does not speak IMAP. Use token with XOAUTH2 on imap.yandex.com / smtp.yandex.com.
