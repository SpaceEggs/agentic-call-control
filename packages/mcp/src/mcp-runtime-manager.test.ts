import assert from 'node:assert/strict';
import test from 'node:test';
import { McpRuntimeManager } from './mcp-runtime-manager.ts';
import { CustomMcpConnection, McpLocalAuthorizationRequiredError } from './custom-mcp-client.ts';

test('disabled MCP servers do not expose tools or open connections', async () => {
    const manager = new McpRuntimeManager([{
        id: 'disabled',
        name: 'Disabled',
        url: 'https://example.test/mcp',
        enabled: false,
        auth: { type: 'none' },
    }]);
    await manager.initialize();
    assert.equal(manager.getStates()[0]?.status, 'disabled');
    const lease = manager.acquire();
    assert.equal(lease.router, undefined);
    assert.deepEqual(lease.toolDefs, []);
    lease.release();
    manager.close();
});

test('mcp-remote OAuth refuses to block startup when local credentials are absent', async () => {
    const connection = new CustomMcpConnection({
        id: 'remote-oauth',
        name: 'Remote OAuth',
        url: 'https://example.test/mcp',
        transport: 'mcp-remote',
        mcpRemote: { configDir: `/tmp/mcp-remote-test-${process.pid}-missing` },
        auth: { type: 'oauth' },
    });
    await assert.rejects(
        connection.connect(),
        (error: unknown) => error instanceof McpLocalAuthorizationRequiredError,
    );
});
