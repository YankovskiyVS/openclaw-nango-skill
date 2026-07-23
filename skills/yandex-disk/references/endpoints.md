# Yandex Disk

- **Skill id:** `yandex-disk`
- **Nango provider_config_key:** `yandex-disk`
- **Family:** `yandex`
- **Scopes:** cloud_api:disk.read, cloud_api:disk.write, cloud_api:disk.info, cloud_api:disk.app_folder
- **Upstream base:** `https://cloud-api.yandex.net`

## Examples

### Disk meta

```bash
python3 {baseDir}/scripts/nango_proxy.py call yandex-disk v1/disk --json-output
```

### List root

```bash
python3 {baseDir}/scripts/nango_proxy.py call yandex-disk 'v1/disk/resources' --query 'path=/' --json-output
```

## Notes

Docs: https://yandex.com/dev/disk/api/concepts/about.html
