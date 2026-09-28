import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolExecutor } from '../src/agent/tool-executor.ts';
import { parseFunctionCallItems, argumentsToJson } from '../src/providers/seeduplex-protocol.ts';

test('seeduplex: malformed hangup arguments are rejected before tool execution', async () => {
    const executor = createToolExecutor({} as never);
    for (const args of ['', 'broken', 'null', '[]', '42', 'true']) {
        await assert.rejects(executor.execute('drop_call', args));
    }
});

test('Seeduplex malformed wire arguments never become a valid empty object', () => {
    for (const args of [undefined, null, [], 42, false]) {
        const [call] = parseFunctionCallItems({ items: [{ call_id: 'c1', name: 'drop_call', arguments: args }] });
        assert.throws(() => argumentsToJson(call.arguments));
    }
});
