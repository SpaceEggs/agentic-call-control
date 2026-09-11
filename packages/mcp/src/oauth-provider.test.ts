import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PersistentOAuthProvider } from './oauth-provider.ts';

test('PersistentOAuthProvider stores credentials with mode 0600 and clears tokens', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-oauth-'));
    const path = join(root, 'nested', 'tokens.json');
    const provider = new PersistentOAuthProvider({
        serverName: 'test',
        redirectUrl: 'https://admin.example.test/api/mcp/oauth/callback',
        tokenFile: path,
        openBrowser: false,
    });
    provider.saveTokens({ access_token: 'secret', token_type: 'bearer' });
    assert.equal(provider.tokens()?.access_token, 'secret');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    provider.clearAuthorization();
    assert.equal(provider.tokens(), undefined);
    assert.equal(provider.redirectUrl.toString(), 'https://admin.example.test/api/mcp/oauth/callback');
});

test('revokeTokens clears local credentials when remote revocation is unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-oauth-revoke-'));
    const provider = new PersistentOAuthProvider({
        serverName: 'test',
        tokenFile: join(root, 'tokens.json'),
        openBrowser: false,
    });
    provider.redirectToAuthorization(new URL('http://127.0.0.1:1/authorize'));
    provider.saveTokens({ access_token: 'secret', token_type: 'bearer' });

    assert.equal(await provider.revokeTokens(), false);
    assert.equal(provider.tokens(), undefined);
});
