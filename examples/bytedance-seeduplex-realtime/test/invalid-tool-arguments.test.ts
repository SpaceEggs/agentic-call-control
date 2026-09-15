import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolExecutor as openai } from '../../openai-realtime/src/agent/tool-executor.ts';
import { createToolExecutor as xai } from '../../xai-realtime/src/agent/tool-executor.ts';
import { createToolExecutor as seeduplex } from '../src/agent/tool-executor.ts';
import { parseFunctionCallItems, argumentsToJson } from '../src/providers/seeduplex-protocol.ts';

for (const [name, factory, tool] of [
    ['openai', openai, 'drop_call'], ['xai', xai, 'end_call'],
    ['seeduplex', seeduplex, 'drop_call'],
] as const) {
    test(`${name}: malformed hangup arguments are rejected before tool execution`, async () => {
        const executor = factory({} as never);
        for (const args of ['', 'broken', 'null', '[]', '42', 'true']) {
            await assert.rejects(executor.execute(tool, args));
        }
    });
}

test('Seeduplex malformed wire arguments never become a valid empty object', () => {
    for (const args of [undefined, null, [], 42, false]) {
        const [call] = parseFunctionCallItems({ items: [{ call_id: 'c1', name: 'drop_call', arguments: args }] });
        assert.throws(() => argumentsToJson(call.arguments));
    }
});
