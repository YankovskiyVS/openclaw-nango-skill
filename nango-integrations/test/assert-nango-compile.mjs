import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const expectedActions = new Map([
    ['amocrm-chats-channel', ['send-message']],
    ['yandex-mail', ['get-message', 'list-messages', 'resolve-mailbox', 'send-message']]
]);

function option(name, fallback) {
    const index = process.argv.indexOf(name);
    if (index === -1) {
        return fallback;
    }
    assert.ok(process.argv[index + 1], `${name} requires a path`);
    return process.argv[index + 1];
}

const manifestPath = option('--manifest', new URL('../.nango/nango.json', import.meta.url));
const buildDirectory = option('--build-dir', new URL('../build/', import.meta.url));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.ok(Array.isArray(manifest), '.nango/nango.json must contain an integration array');
assert.equal(manifest.length, expectedActions.size, 'Nango must compile exactly two integrations');
const providerKeys = manifest.map((integration) => integration?.providerConfigKey);
assert.equal(new Set(providerKeys).size, providerKeys.length, 'Nango providerConfigKey values must be unique');
assert.deepEqual(
    [...providerKeys].sort(),
    [...expectedActions.keys()].sort(),
    'Nango must compile exactly the expected providerConfigKey values'
);

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
const artifacts = (await readdir(buildDirectory))
    .filter((name) => name.endsWith('.cjs'))
    .sort();
assert.deepEqual(artifacts, expectedArtifacts, 'Nango must emit exactly the five declared action bundles');

process.stdout.write('Verified 2 Nango integrations, 5 versioned actions and 5 build artifacts.\n');
