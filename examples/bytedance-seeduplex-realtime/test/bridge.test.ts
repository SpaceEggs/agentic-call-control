import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { createSeeduplexRealtimeBridge } from '../src/providers/seeduplex-realtime.ts';
import type { SeeduplexRealtimeConfig } from '../src/providers/seeduplex-realtime.ts';
import { EVENT } from '../src/providers/seeduplex-protocol.ts';

interface FakeWriter {
    cancelled: boolean;
    writes: Buffer[];
    bufferedBytes: number;
    clearCount: number;
    cancelCount: number;
    cancel(): void;
    clear(): void;
    write(chunk: Buffer): void;
}

function createFakeWriter(): FakeWriter {
    const writer: FakeWriter = {
        cancelled: false,
        writes: [],
        bufferedBytes: 0,
        clearCount: 0,
        cancelCount: 0,
        cancel() {
            this.cancelCount += 1;
            this.cancelled = true;
        },
        clear() {
            this.clearCount += 1;
            this.writes = [];
            this.bufferedBytes = 0;
        },
        write(chunk: Buffer) {
            if (!this.cancelled) {
                this.writes.push(chunk);
                this.bufferedBytes += chunk.length;
            }
        },
    };
    return writer;
}

function createFakeParticipant() {
    const writer = createFakeWriter();
    let streamResolve: ((s: NodeJS.ReadableStream) => void) | null = null;
    const streamPromise = new Promise<NodeJS.ReadableStream>((resolve) => {
        streamResolve = resolve;
    });
    const stream = new Readable({ read() { } });
    let transferImpl: () => Promise<void> = async () => { };

    const participant = {
        id: 1,
        info: { party_caller_name: 'T', party_caller_id: '1001' },
        getAudioWriter: () => writer,
        getAudioStream: () => streamPromise,
        transfer: (_d: string) => transferImpl(),
        drop: async () => { },
        transferToVoiceMail: async (_d: string) => { },
        attachPartyData: async (_d: unknown) => { },
        cancelStreamQueue: async () => { },
    };

    return {
        participant: participant as unknown as Parameters<typeof createSeeduplexRealtimeBridge>[0],
        writer,
        stream,
        resolveStream: () => streamResolve?.(stream),
        setTransferImpl: (fn: () => Promise<void>) => {
            transferImpl = fn;
        },
    };
}

function baseConfig(overrides: Partial<SeeduplexRealtimeConfig> = {}): SeeduplexRealtimeConfig {
    return {
        volcApiKey: 'test-key',
        volcAppId: 'test-app',
        model: '1.2.6.0',
        voice: 'zh_female_vv_jupiter_bigtts',
        instructions: 'test agent',
        localTools: [
            {
                type: 'function',
                name: 'transfer_call',
                description: 'Transfer',
                parameters: { type: 'object', properties: { destination: { type: 'string' } }, required: ['destination'] },
            },
        ],
        greeting: '您好',
        speakOnRouteFailure: false,
        routeFailureUserReply: '',
        ...overrides,
    };
}

async function startMockServer(): Promise<{
    url: string;
    received: Record<string, unknown>[];
    headers: Record<string, string | string[] | undefined>;
    send: (obj: Record<string, unknown>) => void;
    close: () => Promise<void>;
}> {
    const received: Record<string, unknown>[] = [];
    const clients: WebSocket[] = [];
    let lastHeaders: Record<string, string | string[] | undefined> = {};

    const server = createServer((_req, res) => {
        res.writeHead(426);
        res.end();
    });
    const wss = new WebSocketServer({ server });
    wss.on('connection', (socket, req) => {
        lastHeaders = req.headers as Record<string, string | string[] | undefined>;
        clients.push(socket);
        socket.on('message', (data) => {
            try {
                received.push(JSON.parse(data.toString()) as Record<string, unknown>);
            } catch {
                /* ignore */
            }
        });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no address');
    const url = `ws://127.0.0.1:${addr.port}`;

    return {
        url,
        get received() {
            return received;
        },
        get headers() {
            return lastHeaders;
        },
        send: (obj) => {
            for (const c of clients) {
                if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(obj));
            }
        },
        close: async () => {
            for (const c of clients) c.terminate();
            await new Promise<void>((resolve) => wss.close(() => resolve()));
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

async function waitUntil(fn: () => boolean, timeoutMs = 500): Promise<void> {
    const start = Date.now();
    while (!fn()) {
        if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout');
        await new Promise((r) => setTimeout(r, 10));
    }
}

test('T02 handshake: official session.create layout and no greeting before ready', async () => {
    const mock = await startMockServer();
    const fake = createFakeParticipant();
    const bridge = createSeeduplexRealtimeBridge(
        fake.participant,
        baseConfig({ wsUrl: mock.url }),
        async () => ({ content: 'ok' }),
    );

    await waitUntil(() => mock.received.length >= 1);

    assert.equal(mock.received[0].type, EVENT.sessionCreate);
    const session = mock.received[0].session as Record<string, unknown>;
    assert.ok(Array.isArray(session.tools));
    assert.equal(typeof session.id, 'string');
    assert.deepEqual(mock.received[0].extension, { asr: {}, tts: {}, dialog: {} });
    assert.equal(mock.headers['x-api-key'], 'test-key');
    assert.equal(mock.headers['x-api-app-id'], 'test-app');
    assert.equal(mock.headers.authorization, undefined);

    const greetingMsgs = mock.received.filter((m) => m.type === EVENT.speechTextCommit);
    assert.equal(greetingMsgs.length, 0, 'greeting must not be sent before ready');

    mock.send({ type: 'session.created' });
    mock.send({ type: 'session.created' });
    mock.send({ type: 'session.updated' });
    await waitUntil(() => bridge.getPhase() === 'ready');

    const greetings = mock.received.filter((m) => m.type === EVENT.speechTextCommit);
    assert.equal(greetings.length, 1, 'greeting exactly once');

    bridge.stop();
    bridge.stop();
    assert.equal(bridge.getPhase(), 'closed');
    await mock.close();
});

test('T03 a response event alone must NOT mark session ready', async () => {
    const mock = await startMockServer();
    const fake = createFakeParticipant();
    const bridge = createSeeduplexRealtimeBridge(
        fake.participant,
        baseConfig({ wsUrl: mock.url }),
        async () => ({ content: 'ok' }),
    );

    await waitUntil(() => mock.received.length >= 1);
    mock.send({ type: EVENT.outputAudioStarted, response_id: 'r1' });
    await new Promise((r) => setTimeout(r, 50));

    assert.notEqual(bridge.getPhase(), 'ready');
    const greetings = mock.received.filter((m) => m.type === EVENT.speechTextCommit);
    assert.equal(greetings.length, 0);

    mock.send({ type: 'session.created' });
    await waitUntil(() => bridge.getPhase() === 'ready');
    bridge.stop();
    await mock.close();
});

test('uplink audio is packetized into official 20 ms / 640-byte PCM frames', async () => {
    const mock = await startMockServer();
    const fake = createFakeParticipant();
    const bridge = createSeeduplexRealtimeBridge(
        fake.participant,
        baseConfig({ wsUrl: mock.url }),
        async () => ({ content: 'ok' }),
    );

    await waitUntil(() => mock.received.length >= 1);
    mock.send({ type: EVENT.sessionCreated, session: { id: 'dialog-1' } });
    await waitUntil(() => bridge.getPhase() === 'ready');
    fake.resolveStream();
    await new Promise((resolve) => setTimeout(resolve, 10));

    fake.stream.push(Buffer.alloc(160)); // 10 ms at 8 kHz -> 320 bytes at 16 kHz
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(mock.received.filter((message) => message.type === EVENT.inputAudioAppend).length, 0);

    fake.stream.push(Buffer.alloc(160));
    await waitUntil(() => mock.received.some((message) => message.type === EVENT.inputAudioAppend));
    const audio = mock.received.find((message) => message.type === EVENT.inputAudioAppend)?.audio;
    assert.equal(typeof audio, 'string');
    assert.equal(Buffer.from(audio as string, 'base64').length, 640);

    bridge.stop();
    await mock.close();
});

test('barge-in uses clear() not cancel(); next reply still plays', async () => {
    const mock = await startMockServer();
    const fake = createFakeParticipant();
    const bridge = createSeeduplexRealtimeBridge(
        fake.participant,
        baseConfig({ wsUrl: mock.url }),
        async () => ({ content: 'ok' }),
    );

    await waitUntil(() => mock.received.length >= 1);
    mock.send({ type: 'session.created' });
    await waitUntil(() => bridge.getPhase() === 'ready');
    fake.resolveStream();

    const pcm24 = Buffer.alloc(480 * 2);
    for (let i = 0; i < 480; i++) pcm24.writeInt16LE(100, i * 2);

    mock.send({
        type: EVENT.outputAudioDelta,
        delta: pcm24.toString('base64'),
        response_id: 'r1',
    });
    await waitUntil(() => fake.writer.writes.length > 0);
    const writesBefore = fake.writer.writes.length;

    mock.send({ type: EVENT.inputAudioTranscriptionStarted });
    await waitUntil(() => fake.writer.clearCount > 0);

    assert.equal(fake.writer.cancelCount, 0, 'barge-in must NOT call permanent cancel()');
    assert.equal(fake.writer.cancelled, false, 'writer must stay writable after barge-in');
    assert.ok(fake.writer.clearCount >= 1, 'barge-in must clear() the buffer');
    const cancels = mock.received.filter((m) => m.type === EVENT.responseCancel);
    assert.equal(cancels.length, 1);

    // Late delta for cancelled response is dropped.
    mock.send({
        type: EVENT.outputAudioDelta,
        delta: pcm24.toString('base64'),
        response_id: 'r1',
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fake.writer.writes.length, 0, 'late r1 audio must be dropped after clear');

    // New response with a new id must play.
    mock.send({ type: EVENT.outputAudioStarted, response_id: 'r2' });
    mock.send({
        type: EVENT.outputAudioDelta,
        delta: pcm24.toString('base64'),
        response_id: 'r2',
    });
    await waitUntil(() => fake.writer.writes.length > 0);
    assert.ok(fake.writer.writes.length > 0, 'next reply must play after barge-in');
    assert.ok(writesBefore >= 0);
    assert.equal(fake.writer.cancelled, false);

    bridge.stop();
    assert.equal(fake.writer.cancelCount, 1, 'stop() is the only permanent cancel');
    await mock.close();
});

test('barge-in during tool streaming still cancels playback immediately', async () => {
    const mock = await startMockServer();
    const fake = createFakeParticipant();
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
        releaseTool = resolve;
    });
    const bridge = createSeeduplexRealtimeBridge(
        fake.participant,
        baseConfig({ wsUrl: mock.url }),
        async () => {
            await toolGate;
            return { content: 'slow-tool' };
        },
    );

    await waitUntil(() => mock.received.length >= 1);
    mock.send({ type: 'session.created' });
    await waitUntil(() => bridge.getPhase() === 'ready');
    fake.resolveStream();

    // Start a slow tool.
    mock.send({
        type: EVENT.functionCallArgumentsDone,
        items: [{ call_id: 't1', name: 'transfer_call', arguments: { destination: '101' } }],
    });
    await waitUntil(() => bridge.getDiagnostics().toolDrainRunning);

    mock.send({ type: 'response.function_call_arguments.delta' });
    mock.send({ type: EVENT.inputAudioTranscriptionStarted });
    await waitUntil(() => fake.writer.clearCount > 0);

    assert.equal(fake.writer.cancelCount, 0, 'tool-stream barge-in must not permanently cancel');
    assert.ok(fake.writer.clearCount >= 1, 'playback cancel cannot wait for tools');
    const cancels = mock.received.filter((m) => m.type === EVENT.responseCancel);
    assert.equal(cancels.length, 0, 'no response.cancel is sent when no response is active');

    releaseTool();
    bridge.stop();
    await mock.close();
});

test('T06/T08 single-flight: overlapping batches do not run tools concurrently', async () => {
    const mock = await startMockServer();
    const fake = createFakeParticipant();
    let running = 0;
    let maxRunning = 0;
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });

    const bridge = createSeeduplexRealtimeBridge(
        fake.participant,
        baseConfig({
            wsUrl: mock.url,
            localTools: [
                { type: 'function', name: 'transfer_call', description: 't', parameters: { type: 'object', properties: {} } },
                { type: 'function', name: 'list_phonebook', description: 'p', parameters: { type: 'object', properties: {} } },
                { type: 'function', name: 'drop_call', description: 'd', parameters: { type: 'object', properties: {} } },
            ],
        }),
        async (name) => {
            running += 1;
            maxRunning = Math.max(maxRunning, running);
            order.push(name);
            await gate;
            running -= 1;
            return { content: `ok-${name}` };
        },
    );

    await waitUntil(() => mock.received.length >= 1);
    mock.send({ type: 'session.created' });
    await waitUntil(() => bridge.getPhase() === 'ready');

    // Batch 1 starts first tool and blocks.
    mock.send({
        type: EVENT.functionCallArgumentsDone,
        items: [{ call_id: 'a1', name: 'transfer_call', arguments: {} }],
    });
    await waitUntil(() => bridge.getDiagnostics().toolDrainRunning);

    // Batch 2 arrives while batch 1 is still running.
    mock.send({
        type: EVENT.functionCallArgumentsDone,
        items: [
            { call_id: 'b1', name: 'list_phonebook', arguments: {} },
            { call_id: 'b2', name: 'drop_call', arguments: {} },
        ],
    });
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(maxRunning, 1, 'tools must never run concurrently');
    assert.equal(order.length, 1, 'second batch waits for single-flight drain');

    release();
    await waitUntil(() => order.length === 3, 500);
    assert.equal(maxRunning, 1, 'still serial after unblocking');
    assert.deepEqual(order, ['transfer_call', 'list_phonebook', 'drop_call']);
    await waitUntil(
        () => mock.received.filter((message) => message.type === EVENT.conversationItemCreate).length === 2,
    );
    const resultEvents = mock.received.filter((message) => message.type === EVENT.conversationItemCreate);
    assert.equal((resultEvents[0].items as unknown[]).length, 1);
    assert.equal((resultEvents[1].items as unknown[]).length, 2, 'second server batch returns one items[] envelope');

    // Duplicate call_id does not re-execute.
    const executedCount = order.length;
    mock.send({
        type: EVENT.functionCallArgumentsDone,
        items: [{ call_id: 'a1', name: 'transfer_call', arguments: {} }],
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(order.length, executedCount);

    bridge.stop();
    await mock.close();
});

test('tool result envelope is the official items[] + content[] shape', async () => {
    const mock = await startMockServer();
    const fake = createFakeParticipant();
    const bridge = createSeeduplexRealtimeBridge(
        fake.participant,
        baseConfig({
            wsUrl: mock.url,
            localTools: [
                { type: 'function', name: 'list_phonebook', description: 'p', parameters: { type: 'object', properties: {} } },
            ],
        }),
        async () => ({ content: 'ok' }),
    );

    await waitUntil(() => mock.received.length >= 1);
    mock.send({ type: 'session.created' });
    await waitUntil(() => bridge.getPhase() === 'ready');

    mock.send({
        type: EVENT.functionCallArgumentsDone,
        items: [{ call_id: 'n1', name: 'list_phonebook', arguments: {} }],
    });
    await waitUntil(() => mock.received.some((m) => m.type === EVENT.conversationItemCreate));

    const results = mock.received.filter((m) => m.type === EVENT.conversationItemCreate);
    const items = results[0].items as Record<string, unknown>[];
    assert.equal(items.length, 1);
    const item = items[0];
    assert.equal(item.role, 'tool');
    assert.equal(item.call_id, 'n1');
    assert.equal(item.type, 'message');
    assert.deepEqual(item.content, [{ type: 'input_text', text: 'ok' }]);

    bridge.stop();
    await mock.close();
});

test('T07 namespaced tool is restored for executor', async () => {
    const mock = await startMockServer();
    const fake = createFakeParticipant();
    const executed: string[] = [];
    const bridge = createSeeduplexRealtimeBridge(
        fake.participant,
        baseConfig({
            wsUrl: mock.url,
            localTools: [
                {
                    type: 'function',
                    name: 'googlecalendar.quick_add',
                    description: 'cal',
                    parameters: { type: 'object', properties: {} },
                },
            ],
        }),
        async (name) => {
            executed.push(name);
            return { content: 'ok' };
        },
    );

    await waitUntil(() => mock.received.length >= 1);
    mock.send({ type: 'session.created' });
    await waitUntil(() => bridge.getPhase() === 'ready');

    mock.send({
        type: EVENT.functionCallArgumentsDone,
        items: [{ call_id: 'n1', name: 'googlecalendar_quick_add', arguments: {} }],
    });
    await waitUntil(() => executed.length > 0);
    assert.deepEqual(executed, ['googlecalendar.quick_add']);
    bridge.stop();
    await mock.close();
});

test('route failure releases lock; success terminates bridge', async () => {
    const mock = await startMockServer();
    const fake = createFakeParticipant();
    fake.setTransferImpl(async () => {
        throw new Error('busy');
    });

    const bridge = createSeeduplexRealtimeBridge(
        fake.participant,
        baseConfig({
            wsUrl: mock.url,
            speakOnRouteFailure: true,
            routeFailureUserReply: 'transfer failed',
            localTools: [
                { type: 'function', name: 'transfer_call', description: 't', parameters: { type: 'object', properties: {} } },
            ],
        }),
        async () => ({ content: 'Transfer failed', action: 'transfer', destination: '101' }),
    );

    await waitUntil(() => mock.received.length >= 1);
    mock.send({ type: 'session.created' });
    await waitUntil(() => bridge.getPhase() === 'ready');

    mock.send({
        type: EVENT.functionCallArgumentsDone,
        items: [{ call_id: 'r1', name: 'transfer_call', arguments: { destination: '101' } }],
    });

    // Wait for the failed transfer to speak the fallback (proves lock was released
    // and the bridge is still serving).
    await waitUntil(
        () => mock.received.some(
            (m) => m.type === EVENT.speechTextCommit && m.text === 'transfer failed',
        ),
        800,
    );
    assert.equal(bridge.getDiagnostics().routeState, 'idle', 'failed transfer must release route lock');
    assert.equal(bridge.getPhase(), 'ready', 'bridge stays alive after failed transfer');

    // Second route attempt is accepted after unlock.
    fake.setTransferImpl(async () => { });
    mock.send({
        type: EVENT.functionCallArgumentsDone,
        items: [{ call_id: 'r2', name: 'transfer_call', arguments: { destination: '102' } }],
    });
    await waitUntil(() => bridge.getPhase() === 'closed', 800);
    assert.equal(bridge.getDiagnostics().routeState, 'terminated');
    await mock.close();
});

test('T10 stop removes input listeners and does not revive', async () => {
    const mock = await startMockServer();
    const fake = createFakeParticipant();
    const bridge = createSeeduplexRealtimeBridge(
        fake.participant,
        baseConfig({ wsUrl: mock.url }),
        async () => ({ content: 'ok' }),
    );

    await waitUntil(() => mock.received.length >= 1);
    mock.send({ type: 'session.created' });
    await waitUntil(() => bridge.getPhase() === 'ready');
    fake.resolveStream();
    await new Promise((r) => setTimeout(r, 20));

    const greetingsBefore = mock.received.filter((m) => m.type === EVENT.speechTextCommit).length;
    assert.equal(greetingsBefore, 1);

    bridge.stop();
    bridge.stop();
    assert.equal(bridge.getPhase(), 'closed');
    assert.equal(bridge.getDiagnostics().inputListenersRemoved, true);
    assert.equal(fake.stream.listenerCount('data'), 0);
    assert.equal(fake.stream.listenerCount('error'), 0);

    mock.send({ type: 'session.created' });
    await new Promise((r) => setTimeout(r, 30));
    const greetingsAfter = mock.received.filter((m) => m.type === EVENT.speechTextCommit).length;
    assert.equal(greetingsAfter, greetingsBefore, 'no greeting after stop');
    assert.equal(bridge.getPhase(), 'closed');
    await mock.close();
});
