import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const verifier = fileURLToPath(new URL('./assert-nango-compile.mjs', import.meta.url));

describe('Nango compile artifact verifier', () => {
    it('rejects duplicate provider keys even when all five expected artifact names exist', async () => {
        const root = await mkdtemp(join(tmpdir(), 'nango-compile-verifier-'));
        const manifestPath = join(root, 'nango.json');
        const buildDirectory = join(root, 'build');
        const yandexActions = ['get-message', 'list-messages', 'resolve-mailbox', 'send-message'].map((name) => ({
            name,
            version: '1.0.0'
        }));

        try {
            await mkdir(buildDirectory);
            await writeFile(
                manifestPath,
                JSON.stringify([
                    { providerConfigKey: 'yandex-mail', actions: yandexActions, syncs: [] },
                    { providerConfigKey: 'yandex-mail', actions: yandexActions, syncs: [] }
                ])
            );
            for (const artifact of [
                'amocrm-chats-channel_actions_send-message.cjs',
                'yandex-mail_actions_get-message.cjs',
                'yandex-mail_actions_list-messages.cjs',
                'yandex-mail_actions_resolve-mailbox.cjs',
                'yandex-mail_actions_send-message.cjs'
            ]) {
                await writeFile(join(buildDirectory, artifact), '');
            }

            await expect(
                execFileAsync(process.execPath, [
                    verifier,
                    '--manifest',
                    manifestPath,
                    '--build-dir',
                    buildDirectory
                ])
            ).rejects.toMatchObject({ code: 1 });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
