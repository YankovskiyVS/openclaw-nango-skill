import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const expectedActions = new Map([
    ['amocrm-chats-channel', ['send-message']],
    ['yandex-mail', ['get-message', 'list-messages', 'resolve-mailbox', 'send-message']]
]);

const manifest = JSON.parse(await readFile(new URL('../.nango/nango.json', import.meta.url), 'utf8'));
assert.ok(Array.isArray(manifest), '.nango/nango.json must contain an integration array');
assert.equal(manifest.length, expectedActions.size, 'Nango must compile exactly two integrations');

for (const integration of manifest) {
    assert.equal(typeof integration?.providerConfigKey, 'string', 'Every integration needs a providerConfigKey');
    const expected = expectedActions.get(integration.providerConfigKey);
    assert.ok(expected, `Unexpected compiled integration: ${integration.providerConfigKey}`);
    assert.ok(Array.isArray(integration.actions), `${integration.providerConfigKey} actions must be an array`);
    assert.deepEqual(
        integration.actions.map((action) => action.name).sort(),
        expected,
        `${integration.providerConfigKey} compiled an unexpected action set`
    );
    for (const action of integration.actions) {
        assert.equal(
            action.version,
            '1.0.0',
            `${integration.providerConfigKey}/${action.name} must compile at version 1.0.0`
        );
    }
    assert.deepEqual(integration.syncs, [], `${integration.providerConfigKey} must not compile undeclared syncs`);
}

const expectedArtifacts = [...expectedActions]
    .flatMap(([integration, actions]) => actions.map((action) => `${integration}_actions_${action}.cjs`))
    .sort();
const artifacts = (await readdir(new URL('../build/', import.meta.url)))
    .filter((name) => name.endsWith('.cjs'))
    .sort();
assert.deepEqual(artifacts, expectedArtifacts, 'Nango must emit exactly the five declared action bundles');

process.stdout.write('Verified 2 Nango integrations, 5 versioned actions and 5 build artifacts.\n');
