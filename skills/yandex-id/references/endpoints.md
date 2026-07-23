# Yandex ID

- **Skill id:** `yandex-id`
- **Nango provider_config_key:** `yandex-id`
- **Family:** `yandex`
- **Scopes:** login:info, login:email, login:avatar
- **Upstream base:** `https://login.yandex.ru`

## Examples

### GET profile

```bash
python3 {baseDir}/scripts/nango_proxy.py call yandex-id info --query 'format=json' --json-output
```

### legacy key

```bash
python3 {baseDir}/scripts/nango_proxy.py call yandex info --query 'format=json' --json-output
```

## Notes

Legacy Nango unique key `yandex` still works if that is what was connected.
