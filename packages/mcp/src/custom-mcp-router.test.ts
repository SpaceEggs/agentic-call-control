import assert from 'node:assert/strict';
import test from 'node:test';
import { CustomMcpRouter, type CustomMcpConnection } from './custom-mcp-client.ts';

test('agent allowlist hides raw tools while trusted semantic wrappers can call them', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const connection = {
        name: 'ZohoDesk',
        tools: [{
            name: 'ZohoDesk_createTicket',
            description: 'Create a ticket',
            inputSchema: {
                type: 'object',
                properties: {
                    body: { type: 'object' },
                },
            },
        }],
        async callTool(name: string, args: Record<string, unknown>) {
            calls.push({ name, args });
            return JSON.stringify({ id: 'ticket-1' });
        },
        disconnect() { /* test double */ },
    } as unknown as CustomMcpConnection;

    const router = new CustomMcpRouter([connection]);
    router.applyAllowlist([]);

    assert.equal(router.has('ZohoDesk_createTicket'), false);
    assert.equal(router.hasAvailable('ZohoDesk_createTicket'), true);
    assert.deepEqual(router.toolDefs, []);
    assert.equal(router.allToolDefs.length, 1);
    assert.equal(
        await router.callTool('ZohoDesk_createTicket', { body: {} }),
        'Unknown custom MCP tool: ZohoDesk_createTicket',
    );
    assert.equal(
        await router.callAvailableTool('ZohoDesk_createTicket', { body: { subject: 'test' } }),
        JSON.stringify({ id: 'ticket-1' }),
    );
    assert.deepEqual(calls, [{
        name: 'ZohoDesk_createTicket',
        args: { body: { subject: 'test' } },
    }]);
});
