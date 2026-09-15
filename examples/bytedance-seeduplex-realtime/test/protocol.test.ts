import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    SEEDUPLEX_WS_URL,
    AUTH_HEADER_API_KEY,
    AUTH_HEADER_APP_ID,
    EVENT,
    buildAuthHeaders,
    buildSessionCreate,
    buildInputAudioAppend,
    buildSpeechTextCommit,
    buildToolResultItems,
    buildResponseCancel,
    buildSessionClose,
    parseFunctionCallItems,
    argumentsToJson,
    parseJsonEvent,
    extractOutputAudioBase64,
    extractResponseId,
    extractServerError,
} from '../src/providers/seeduplex-protocol.ts';

test('endpoint is the 3.0 duplex dialogue path, not the 1.0 path', () => {
    assert.equal(SEEDUPLEX_WS_URL, 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue');
    assert.ok(!SEEDUPLEX_WS_URL.includes('/api/v3/realtime/dialogue'));
});

test('auth follows Issue #2 while retaining the official X-Api-Key header', () => {
    const headers = buildAuthHeaders('key-1', 'app-1');
    assert.equal(headers[AUTH_HEADER_API_KEY], 'key-1');
    assert.equal(headers[AUTH_HEADER_APP_ID], 'app-1');
    assert.equal(headers.Authorization, undefined);
});

test('session.create matches the official 2026-08 demo layout', () => {
    const create = buildSessionCreate({
        sessionId: 'session-1',
        eventId: 'event-1',
        model: '1.2.6.0',
        voice: 'zh_female_vv_jupiter_bigtts',
        instructions: 'You are a receptionist.',
        inputSampleRate: 16000,
        outputSampleRate: 24000,
        tools: [
            { type: 'function', name: 'transfer_call', description: 't', parameters: { type: 'object' } },
        ],
    });

    assert.equal(create.type, EVENT.sessionCreate);
    assert.equal(create.event_id, 'event-1');
    const session = create.session as Record<string, unknown>;
    assert.equal(session.id, 'session-1');
    assert.equal(session.model, '1.2.6.0');
    assert.ok(Array.isArray(session.tools), 'tools are nested in session, not a session.tools event');
    assert.deepEqual(session.audio, {
        input: { format: { type: 'pcm', rate: 16000 } },
        output: {
            format: { type: 'pcm_s16le', rate: 24000 },
            voice: 'zh_female_vv_jupiter_bigtts',
        },
    });
    assert.deepEqual(create.extension, { asr: {}, tts: {}, dialog: {} });
});

test('audio, greeting, cancel, and close events match official fields', () => {
    assert.deepEqual(buildInputAudioAppend('AAA'), {
        type: EVENT.inputAudioAppend,
        audio: 'AAA',
    });
    assert.deepEqual(buildSpeechTextCommit('您好', 'event-2', 'speech-1'), {
        type: EVENT.speechTextCommit,
        event_id: 'event-2',
        speech_id: 'speech-1',
        text: '您好',
    });
    assert.deepEqual(buildResponseCancel('event-3'), {
        type: EVENT.responseCancel,
        event_id: 'event-3',
    });
    assert.deepEqual(buildSessionClose('event-4'), {
        type: EVENT.sessionClose,
        event_id: 'event-4',
    });
});

test('tool results use official batched items and content blocks', () => {
    const message = buildToolResultItems([
        { callId: 'call-1', output: 'ok' },
        { callId: 'call-2', output: 'done' },
    ], 'event-5');

    assert.equal(message.type, EVENT.conversationItemCreate);
    assert.equal(message.event_id, 'event-5');
    assert.deepEqual(message.items, [
        {
            type: 'message',
            role: 'tool',
            call_id: 'call-1',
            content: [{ type: 'input_text', text: 'ok' }],
        },
        {
            type: 'message',
            role: 'tool',
            call_id: 'call-2',
            content: [{ type: 'input_text', text: 'done' }],
        },
    ]);
});

test('official function-call fixture parses string arguments', () => {
    const items = parseFunctionCallItems({
        type: EVENT.functionCallArgumentsDone,
        event_id: 'event_8899',
        items: [{
            call_id: 'call_weather_001',
            name: 'get_weather',
            arguments: '{"city":"Beijing"}',
        }],
    });
    assert.deepEqual(items, [{
        callId: 'call_weather_001',
        name: 'get_weather',
        arguments: '{"city":"Beijing"}',
    }]);
    assert.equal(argumentsToJson(items[0].arguments), '{"city":"Beijing"}');
});

test('object arguments are tolerated and invalid JSON arguments fail closed', () => {
    const [item] = parseFunctionCallItems({
        items: [{ call_id: 'c1', name: 'list_phonebook', arguments: { query: 'Jon' } }],
    });
    assert.equal(argumentsToJson(item.arguments), '{"query":"Jon"}');
    assert.throws(() => argumentsToJson('[]'), /JSON object/);
    assert.throws(() => argumentsToJson('not-json'), SyntaxError);
});

test('malformed function-call entries are skipped', () => {
    const items = parseFunctionCallItems({
        items: [null, { name: 'missing_call_id' }, { call_id: 'ok', name: 'transfer_call', arguments: '{}' }],
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].callId, 'ok');
});

test('event parsing and official downlink delta fields are strict', () => {
    assert.equal(parseJsonEvent('not-json'), null);
    assert.equal(parseJsonEvent('[1,2]'), null);
    assert.deepEqual(parseJsonEvent('{"type":"x"}'), { type: 'x' });
    assert.equal(extractOutputAudioBase64({ delta: 'BBB' }), 'BBB');
    assert.equal(extractOutputAudioBase64({ audio: 'AAA' }), null);
    assert.equal(extractResponseId({ response_id: 'r1' }), 'r1');
    assert.equal(extractResponseId({ response: { id: 'r2' } }), undefined);
});

test('official nested error envelope is extracted without dumping payloads', () => {
    assert.deepEqual(extractServerError({
        type: 'error',
        error: { type: 'invalid_request', code: '4001', message: 'bad session', param: null },
    }), { code: '4001', message: 'bad session' });
});
