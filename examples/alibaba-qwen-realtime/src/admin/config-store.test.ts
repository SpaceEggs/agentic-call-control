import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AdminConfigStore } from './config-store.ts';

test('admin overlay keeps bearer secrets separate and injects public OAuth callback', () => {
    const root = mkdtempSync(join(tmpdir(), 'qwen-admin-'));
    const store = new AdminConfigStore([
        { id: 'bearer', name: 'Bearer', url: 'https://example.test/mcp', auth: { type: 'bearer', token: 'secret' } },
        { id: 'oauth', name: 'OAuth', url: 'https://oauth.example.test/mcp', auth: { type: 'oauth' } },
    ], join(root, 'admin-state.json'), 'https://admin.example.test');

    const servers = store.getServers();
    assert.equal(servers[0]?.auth?.type, 'bearer');
    assert.equal(servers[0]?.auth?.type === 'bearer' && servers[0].auth.token, 'secret');
    assert.equal(
        servers[1]?.auth?.type === 'oauth' && servers[1].auth.redirectUrl,
        'https://admin.example.test/api/mcp/oauth/callback',
    );
    assert.equal(store.setServerEnabled('oauth', false)[1]?.enabled, false);
    assert.equal(store.revision, 2);
    assert.throws(() => store.saveServers([], 999), /reload/);
});
