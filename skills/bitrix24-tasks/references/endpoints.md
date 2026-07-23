# Bitrix24 Tasks

- **Skill id:** `bitrix24-tasks`
- **Nango provider_config_key:** `bitrix24-tasks`
- **Family:** `bitrix24`
- **Scopes:** task, tasks_extended, sonet_group
- **Upstream base:** `https://{domain}/rest`

## Examples

### List tasks

```bash
python3 {baseDir}/scripts/nango_proxy.py call bitrix24-tasks tasks.task.list --json-output
```
