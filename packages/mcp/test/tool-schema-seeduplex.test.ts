import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeToolDefinitions,
    normalizeToolParameters,
    sanitizeToolName,
} from '../src/tool-schema.ts';

const sampleTool = {
    name: 'googlecalendar.quick_add',
    description: 'Add event',
    parameters: {
        type: 'object',
        properties: {
            summary: { type: 'string' },
            duration_minutes: { type: 'integer', default: 30 },
            all_day: { type: 'boolean' },
        },
        required: ['summary'],
    },
};

test('seeduplex aliases openai: keeps integer/boolean, does not relax to string', () => {
    const params = normalizeToolParameters(sampleTool.parameters, 'seeduplex');
    const props = params.properties as Record<string, Record<string, unknown>>;
    assert.equal(props.summary.type, 'string');
    assert.equal(props.duration_minutes.type, 'integer');
    assert.equal(props.all_day.type, 'boolean');
    assert.equal(props.duration_minutes.default, 30);
});

test('qwen still relaxes scalars — provider behavior unchanged', () => {
    const params = normalizeToolParameters(sampleTool.parameters, 'qwen');
    const props = params.properties as Record<string, Record<string, unknown>>;
    assert.equal(props.duration_minutes.type, 'string');
    assert.equal(props.all_day.type, 'string');
});

test('seeduplex sanitizes dotted tool names and restores originalName', () => {
    const set = normalizeToolDefinitions([sampleTool], 'seeduplex');
    assert.equal(set.tools[0].name, 'googlecalendar_quick_add');
    assert.equal(set.tools[0].originalName, 'googlecalendar.quick_add');
    assert.equal(set.originalNameByName.get('googlecalendar_quick_add'), 'googlecalendar.quick_add');
});

test('seeduplex rejects name collisions after sanitization', () => {
    assert.throws(
        () => normalizeToolDefinitions([
            { name: 'a.b', description: '', parameters: { type: 'object', properties: {} } },
            { name: 'a_b', description: '', parameters: { type: 'object', properties: {} } },
        ], 'seeduplex'),
        /collision/i,
    );
});

test('openai and seeduplex produce identical wire names for MCP tools', () => {
    const a = normalizeToolDefinitions([sampleTool], 'openai');
    const b = normalizeToolDefinitions([sampleTool], 'seeduplex');
    assert.equal(a.tools[0].name, b.tools[0].name);
    assert.deepEqual(a.tools[0].parameters, b.tools[0].parameters);
});

test('sanitizeToolName only allows [a-zA-Z0-9_-]', () => {
    assert.equal(sanitizeToolName('list_phonebook'), 'list_phonebook');
    assert.equal(sanitizeToolName('google.calendar/add'), 'google_calendar_add');
});
