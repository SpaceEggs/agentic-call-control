import WebSocket from 'ws';
import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import type { Participant } from '@3cx/call-control-sdk';
import { normalizeToolDefinitions } from '@3cx-examples/mcp';
import type { ToolResult } from '../agent/tool-executor.ts';
import { detectRequestedTools, createAudioPipeMonitor } from '@3cx-examples/logger';
import type { CallLogger, AudioPipeMonitor } from '@3cx-examples/logger';
import {
    SEEDUPLEX_WS_URL,
    EVENT,
    RATE_UPLINK_HZ,
    RATE_DOWNLINK_HZ,
    UPLINK_FRAME_BYTES,
    buildAuthHeaders,
    buildSessionCreate,
    buildInputAudioAppend,
    buildSpeechTextCommit,
    buildResponseCancel,
    buildSessionClose,
    buildToolResultItems,
    parseFunctionCallItems,
    argumentsToJson,
    parseJsonEvent,
    extractOutputAudioBase64,
    extractResponseId,
    extractServerError,
} from './seeduplex-protocol.ts';
import type { SeeduplexToolWire } from './seeduplex-protocol.ts';
import {
    PcmUpsampler8kTo16k,
    PcmDownsampler24kTo8k,
    PcmFramePacketizer,
} from './pcm-resampler.ts';

/** Named constants (ms / bytes). Final values pending latency tests / official limits. */
const CONNECT_TIMEOUT_MS = 15_000;
const READY_TIMEOUT_MS = 10_000;
const TOOL_EXEC_TIMEOUT_MS = 30_000;
/** Max local PCM bytes buffered on the 3CX writer before dropping new downlink audio. */
const PLAYBACK_BUFFER_MAX_BYTES = 96_000; // ~3s at 8 kHz 16-bit mono
/** Max ws.bufferedBytes equivalent before dropping uplink audio frames. */
const WS_SEND_BUFFER_MAX_BYTES = 256_000;

export type BridgePhase =
    | 'connecting'
    | 'configuring'
    | 'ready'
    | 'closing'
    | 'closed';

export type RouteState = 'idle' | 'in_progress' | 'terminated';

export interface SeeduplexRealtimeConfig {
    volcApiKey: string;
    volcAppId: string;
    model: string;
    voice: string;
    instructions: string;
    localTools: SeeduplexToolWire[];
    greeting: string;
    speakOnRouteFailure: boolean;
    routeFailureUserReply: string;
    fileLog?: CallLogger;
    /** Override for tests. Defaults to the issue-specified duplex URL. */
    wsUrl?: string;
}

export type { SeeduplexToolWire };

export interface BridgeDiagnostics {
    phase: BridgePhase;
    routeState: RouteState;
    outputEpoch: number;
    currentResponseId: string;
    cancelledResponseId: string;
    pendingToolCount: number;
    toolDrainRunning: boolean;
    inputListenersRemoved: boolean;
}

export interface SeeduplexBridgeHandle {
    stop: () => void;
    /** Test helper: current lifecycle phase. */
    getPhase: () => BridgePhase;
    /** Test helper: internal counters for regression assertions. */
    getDiagnostics: () => BridgeDiagnostics;
}

interface PendingFunctionCall {
    callId: string;
    name: string;
    arguments: string | Record<string, unknown>;
}

type PendingFunctionBatch = PendingFunctionCall[];

type ToolCallStatus = 'queued' | 'running' | 'completed';

/**
 * Seeduplex 3.0 text-JSON duplex bridge.
 *
 * Payload shapes are locked to the official 2026-08 Go/Python duplex demos.
 * See docs/development/issue-2-p0-protocol-status.md for evidence and the
 * explicitly documented differences from Issue #2.
 *
 * 3CX writer recovery (SDK ^0.1.10, verified in dist/audio/streams.js):
 * - `AudioWriter.cancel()` sets a permanent `stopping` flag — never use for barge-in.
 * - `AudioWriter.clear()` empties the local PCM buffer and remains writable.
 * - `Participant.cancelStreamQueue()` aborts the PBX upload; writer auto-reconnects.
 * Barge-in uses clear() + cancelStreamQueue(); cancel() only on stop().
 */
export function createSeeduplexRealtimeBridge(
    participant: Participant,
    config: SeeduplexRealtimeConfig,
    executeTool: (name: string, argsJson: string) => Promise<ToolResult>,
): SeeduplexBridgeHandle {
    const log = config.fileLog ?? createNoopLogger();
    let stopped = false;
    let phase: BridgePhase = 'connecting';
    let ws: WebSocket | null = null;
    let currentResponseId = '';
    let responseActive = false;
    let audioMonitor: AudioPipeMonitor | null = null;
    let greetingSent = false;
    let audioPipeStarted = false;
    let connectTimer: NodeJS.Timeout | null = null;
    let readyTimer: NodeJS.Timeout | null = null;
    let eventIdCounter = 0;
    const sessionId = randomUUID();

    /** Local output generation — increments on barge-in to drop late deltas. */
    let outputEpoch = 0;
    /** Response id cancelled by the last barge-in (empty = none). */
    let cancelledResponseId = '';

    let routeState: RouteState = 'idle';
    let toolCallStreaming = false;
    const pendingBatches: PendingFunctionBatch[] = [];
    const toolCallStatus = new Map<string, ToolCallStatus>();
    let toolDrainRunning = false;

    /** Input stream bookkeeping so stop() can detach listeners. */
    let inputStream: NodeJS.ReadableStream | null = null;
    const inputHandlers: Array<{ event: string; handler: (...args: never[]) => void }> = [];
    let inputListenersRemoved = false;

    const upsampler = new PcmUpsampler8kTo16k();
    const downsampler = new PcmDownsampler24kTo8k();
    const uplinkPacketizer = new PcmFramePacketizer(UPLINK_FRAME_BYTES);

    let agentTranscriptBuf = '';
    let callerTranscriptBuf = '';
    const audioWriter = participant.getAudioWriter();

    const normalizedTools = normalizeToolDefinitions(
        config.localTools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        })),
        'seeduplex',
    );
    const wireTools: SeeduplexToolWire[] = normalizedTools.tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
    }));
    const originalNameByName = normalizedTools.originalNameByName;

    const nextEventId = () => `event_${++eventIdCounter}`;

    const setPhase = (next: BridgePhase) => {
        if (phase === next) return;
        phase = next;
        log.info(`PHASE | ${next}`);
    };

    const send = (obj: Record<string, unknown>, opts?: { isMedia?: boolean }) => {
        if (stopped || phase === 'closing' || phase === 'closed') return;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        // Bounded uplink: drop media when the socket send buffer is backing up.
        if (opts?.isMedia && ws.bufferedAmount > WS_SEND_BUFFER_MAX_BYTES) {
            log.warn(`WS_SEND_BUFFER_HIGH | buffered=${ws.bufferedAmount} max=${WS_SEND_BUFFER_MAX_BYTES}`);
            return;
        }
        ws.send(JSON.stringify(obj));
    };

    const clearTimers = () => {
        if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
        }
        if (readyTimer) {
            clearTimeout(readyTimer);
            readyTimer = null;
        }
    };

    const startReadyTimeout = () => {
        if (readyTimer) clearTimeout(readyTimer);
        readyTimer = setTimeout(() => {
            if (phase === 'configuring') {
                log.error(`READY_TIMEOUT | ms=${READY_TIMEOUT_MS}`);
                console.error(chalk.red(`[Seeduplex] session ready timeout after ${READY_TIMEOUT_MS}ms`));
                stop();
            }
        }, READY_TIMEOUT_MS);
    };

    const sendSessionCreate = () => {
        setPhase('configuring');
        startReadyTimeout();

        const payload = buildSessionCreate({
            sessionId,
            eventId: nextEventId(),
            model: config.model,
            voice: config.voice,
            instructions: config.instructions,
            inputSampleRate: RATE_UPLINK_HZ,
            outputSampleRate: RATE_DOWNLINK_HZ,
            tools: wireTools,
        });
        send(payload);

        log.systemPrompt(config.instructions);
        log.info(
            `SESSION_CREATE | model=${config.model} voice=${config.voice}`,
        );
        console.log(
            chalk.cyan(
                `[Seeduplex] session.create sent (model: ${config.model}, voice: ${config.voice})`,
            ),
        );

        log.info(`SESSION_TOOLS | count=${wireTools.length} names=${wireTools.map((t) => t.name).join(',')}`);
        console.log(chalk.cyan(`[Seeduplex] session.create sent with ${wireTools.length} tools`));
    };

    const markReady = (reason: string) => {
        if (phase === 'ready' || stopped) return;
        setPhase('ready');
        if (readyTimer) {
            clearTimeout(readyTimer);
            readyTimer = null;
        }
        log.info(`SESSION_READY | reason="${reason}" tools_registered=${wireTools.length}`);
        console.log(chalk.green(`[Seeduplex] session ready (${reason})`));
        sendGreetingOnce();
        startAudioPipeOnce();
    };

    const sendGreetingOnce = () => {
        if (greetingSent || stopped) return;
        greetingSent = true;
        send(buildSpeechTextCommit(config.greeting, nextEventId(), randomUUID()));
        log.info(`GREETING_SENT | "${config.greeting}"`);
        console.log(chalk.cyan(`[Seeduplex] greeting sent: "${config.greeting}"`));
    };

    const detachInputStream = () => {
        if (!inputStream || inputListenersRemoved) return;
        for (const { event, handler } of inputHandlers) {
            try {
                inputStream.removeListener(event, handler as never);
            } catch {
                // ignore
            }
        }
        inputHandlers.length = 0;
        inputListenersRemoved = true;
    };

    const startAudioPipeOnce = () => {
        if (audioPipeStarted || stopped) return;
        audioPipeStarted = true;
        audioMonitor = createAudioPipeMonitor(log);

        participant.getAudioStream()
            .then((audioStream) => {
                if (stopped) {
                    try {
                        audioStream.destroy();
                    } catch {
                        // ignore
                    }
                    return;
                }
                inputStream = audioStream;

                const onData = (chunk: Buffer) => {
                    if (stopped || phase !== 'ready') return;
                    audioMonitor?.onChunk(chunk.length);
                    const up = upsampler.process(chunk);
                    if (up.length === 0) return;
                    for (const frame of uplinkPacketizer.process(up)) {
                        send(buildInputAudioAppend(frame.toString('base64')), { isMedia: true });
                    }
                };
                const onEnd = () => audioMonitor?.onStreamEnd();
                const onClose = () => audioMonitor?.onStreamClose();
                const onError = (err: Error) => {
                    audioMonitor?.onStreamError(err);
                    console.error(chalk.red('[Seeduplex] audio stream error:'), err.message);
                };

                audioStream.on('data', onData);
                audioStream.on('end', onEnd);
                audioStream.on('close', onClose);
                audioStream.on('error', onError);
                inputHandlers.push(
                    { event: 'data', handler: onData as never },
                    { event: 'end', handler: onEnd as never },
                    { event: 'close', handler: onClose as never },
                    { event: 'error', handler: onError as never },
                );
            })
            .catch((err: Error) => {
                log.error(`AUDIO_PIPE_INIT_ERROR | error="${err.message}"`);
                console.error(chalk.red('[Seeduplex] getAudioStream error:'), err.message);
            });
    };

    /**
     * Recoverable local barge-in.
     * Does NOT call audioWriter.cancel() — that permanently kills the sink on SDK ^0.1.10.
     */
    const performLocalBargeIn = (reason: string) => {
        outputEpoch += 1;
        cancelledResponseId = currentResponseId;
        downsampler.reset();
        agentTranscriptBuf = '';
        callerTranscriptBuf = '';

        try {
            // Clear local playback buffer; writer stays writable for the next reply.
            audioWriter.clear();
        } catch (err) {
            log.error(`AUDIO_WRITER_CLEAR_ERROR | error="${(err as Error).message}"`);
        }

        // Heavier cancel of already-queued PBX audio. Writer reconnects automatically.
        void participant.cancelStreamQueue().catch((err: Error) => {
            log.warn(`CANCEL_STREAM_QUEUE_ERROR | error="${err.message}"`);
        });

        responseActive = false;
        log.speechEvent('AGENT_INTERRUPTED');
        log.info(
            `BARGE_IN | reason="${reason}" epoch=${outputEpoch} response_active=${responseActive}`
            + ` cancelled_response=${cancelledResponseId || '<none>'}`,
        );
        console.log(chalk.gray(`[Seeduplex] barge-in (${reason}), epoch=${outputEpoch}`));
    };

    const handleEvent = (event: Record<string, unknown>) => {
        const type = typeof event.type === 'string' ? event.type : '';

        const eventResponseId = extractResponseId(event);

        switch (type) {
            case EVENT.sessionCreated:
                if (phase === 'configuring' || phase === 'connecting') {
                    markReady(type);
                } else {
                    log.info(`SESSION_EVENT | ${type} (ignored, phase=${phase})`);
                }
                break;

            case EVENT.sessionUpdated:
                log.info(`SESSION_EVENT | ${type}`);
                break;

            case EVENT.outputAudioStarted:
                if (eventResponseId) {
                    currentResponseId = eventResponseId;
                    cancelledResponseId = '';
                    log.responseCreated(currentResponseId);
                }
                responseActive = true;
                break;

            case EVENT.outputAudioDelta: {
                if (eventResponseId && eventResponseId !== cancelledResponseId) {
                    currentResponseId = eventResponseId;
                }

                // Drop deltas belonging to a response cancelled by barge-in.
                if (eventResponseId && cancelledResponseId && eventResponseId === cancelledResponseId) {
                    log.info(`LATE_AUDIO_DROPPED | response_id=${eventResponseId} epoch=${outputEpoch}`);
                    break;
                }

                const b64 = extractOutputAudioBase64(event);
                if (!b64) break;
                // stop() cancelled the writer permanently; barge-in does not.
                if (stopped || audioWriter.cancelled) break;

                // Bounded playback: drop if local buffer is already too deep.
                if (audioWriter.bufferedBytes > PLAYBACK_BUFFER_MAX_BYTES) {
                    log.warn(
                        `PLAYBACK_BUFFER_HIGH | buffered=${audioWriter.bufferedBytes} max=${PLAYBACK_BUFFER_MAX_BYTES}`,
                    );
                    break;
                }

                const pcm = Buffer.from(b64, 'base64');
                const down = downsampler.process(pcm);
                if (down.length > 0) {
                    audioWriter.write(down);
                }
                responseActive = true;
                break;
            }

            case 'response.output_audio_transcript.delta':
            case 'response.audio_transcript.delta':
            case EVENT.outputTextDelta:
                agentTranscriptBuf += (typeof event.delta === 'string' ? event.delta : '');
                break;

            case 'response.output_audio_transcript.done':
            case 'response.audio_transcript.done':
            case EVENT.outputTextDone: {
                const transcript = (
                    typeof event.text === 'string' && event.text.trim()
                        ? event.text
                        : agentTranscriptBuf
                ).trim();
                if (transcript) {
                    log.transcript('agent', transcript);
                    console.log(chalk.blueBright(`[Agent] "${transcript}"`));
                }
                agentTranscriptBuf = '';
                break;
            }

            case EVENT.inputAudioTranscriptionStarted: {
                log.speechEvent('CALLER_SPEECH_START');
                callerTranscriptBuf = '';
                // Barge-in must not wait for tools. Playback stops immediately;
                // in-flight tool execution continues independently.
                const suppressedForTools = toolCallStreaming;
                const shouldCancelResponse = responseActive;
                performLocalBargeIn(
                    suppressedForTools ? 'speech_started_during_tool_stream' : 'speech_started',
                );
                if (shouldCancelResponse) send(buildResponseCancel(nextEventId()));
                break;
            }

            case EVENT.inputAudioTranscriptionDelta:
                callerTranscriptBuf += typeof event.delta === 'string' ? event.delta : '';
                break;

            case EVENT.inputAudioTranscriptionCompleted: {
                const transcript = (
                    typeof event.transcript === 'string' && event.transcript.trim()
                        ? event.transcript
                        : callerTranscriptBuf
                ).trim();
                if (transcript) {
                    log.transcript('caller', transcript);
                    console.log(chalk.yellowBright(`[User] "${transcript}"`));
                }
                callerTranscriptBuf = '';
                break;
            }

            case 'response.function_call_arguments.delta':
                toolCallStreaming = true;
                break;

            case EVENT.functionCallArgumentsDone: {
                toolCallStreaming = false;
                const batch: PendingFunctionBatch = [];
                const items = parseFunctionCallItems(event);
                for (const item of items) {
                    if (toolCallStatus.has(item.callId)) {
                        log.warn(`TOOL_CALL_DUPLICATE | call_id=${item.callId} name=${item.name}`);
                        continue;
                    }
                    toolCallStatus.set(item.callId, 'queued');
                    batch.push(item);
                    const argsPreview = typeof item.arguments === 'string'
                        ? item.arguments.substring(0, 200)
                        : JSON.stringify(item.arguments).substring(0, 200);
                    log.toolCalled(item.name, item.callId, argsPreview);
                    console.log(chalk.cyan(`[Tool] ${item.name}(${argsPreview})`));
                }
                if (batch.length > 0) pendingBatches.push(batch);
                scheduleToolDrain();
                break;
            }

            case EVENT.responseDone: {
                responseActive = false;
                toolCallStreaming = false;
                const status = (event.response as { status?: string } | undefined)?.status ?? 'completed';
                log.responseDone(currentResponseId || '<unknown>', status);
                log.speechEvent('AGENT_SPEECH_STOP');
                scheduleToolDrain();
                break;
            }

            case EVENT.outputAudioDone:
                responseActive = false;
                break;

            case EVENT.responseCanceled:
                responseActive = false;
                break;

            case EVENT.sessionClosed:
                stop(false);
                break;

            case EVENT.error: {
                const { code, message } = extractServerError(event);
                log.error(`SERVER_ERROR | code=${code} message=${message.substring(0, 400)}`);
                console.error(chalk.red('[Seeduplex] server error:'), message.substring(0, 400));
                if (phase === 'connecting' || phase === 'configuring') stop();
                break;
            }

            default:
                log.info(`UNKNOWN_EVENT | type=${type || '<missing>'}`);
                console.log(chalk.gray(`[Seeduplex] unhandled: ${type || '<missing>'}`));
        }
    };

    const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
            promise.then(
                (v) => {
                    clearTimeout(timer);
                    resolve(v);
                },
                (e) => {
                    clearTimeout(timer);
                    reject(e);
                },
            );
        });
    };

    /**
     * Single-flight tool drain. Additional scheduleToolDrain() calls while a
     * drain is running are no-ops; the running loop keeps consuming batches.
     */
    const scheduleToolDrain = () => {
        if (toolDrainRunning || stopped) return;
        if (pendingBatches.length === 0) return;
        toolDrainRunning = true;
        void drainPendingCalls().finally(() => {
            toolDrainRunning = false;
            // Items may have been queued while the previous drain was finishing.
            if (!stopped && pendingBatches.length > 0) {
                scheduleToolDrain();
            }
        });
    };

    const drainPendingCalls = async () => {
        while (pendingBatches.length > 0 && !stopped) {
            const batch = pendingBatches.shift()!;
            const outputs: Array<{ callId: string; output: string }> = [];
            let routeAction: ToolResult | null = null;

            // Keep local and MCP effects serialized. The official envelope is
            // still batched and is sent once all results are available.
            for (const call of batch) {
                const status = toolCallStatus.get(call.callId);
                if (status === 'completed' || status === 'running') continue;
                toolCallStatus.set(call.callId, 'running');

                const originalName = originalNameByName.get(call.name);
                try {
                    if (!originalName) throw new Error(`unknown tool: ${call.name}`);
                    const argsJson = argumentsToJson(call.arguments);
                    const result = await withTimeout(
                        executeTool(originalName, argsJson),
                        TOOL_EXEC_TIMEOUT_MS,
                        `tool ${originalName}`,
                    );
                    if (stopped) return;
                    toolCallStatus.set(call.callId, 'completed');
                    outputs.push({ callId: call.callId, output: result.content });
                    log.toolResult(originalName, call.callId, result.content);
                    for (const req of detectRequestedTools(result.content)) {
                        log.ruleInjected(req.tool, call.callId, result.content);
                    }
                    if (result.action && !routeAction) routeAction = result;
                } catch (err) {
                    if (stopped) return;
                    const message = (err as Error).message;
                    toolCallStatus.set(call.callId, 'completed');
                    log.error(`TOOL_EXEC_ERROR | tool=${call.name} call_id=${call.callId} error="${message}"`);
                    console.error(chalk.red(`[Seeduplex] tool exec error (${call.name}):`), message);
                    const output = `Error: ${message}`;
                    outputs.push({ callId: call.callId, output });
                    log.toolResult(call.name, call.callId, output);
                }
            }

            if (outputs.length > 0) {
                send(buildToolResultItems(outputs, nextEventId()));
            }
            if (routeAction) executeCallAction(routeAction);
        }
    };

    const executeCallAction = (result: ToolResult) => {
        if (routeState !== 'idle') {
            log.warn(`ROUTE_ALREADY_${routeState.toUpperCase()} | ignoring additional route action`);
            return;
        }
        routeState = 'in_progress';

        // Cancel in-flight TTS before the SDK route action.
        const shouldCancelResponse = responseActive;
        performLocalBargeIn('route_action');
        if (shouldCancelResponse) send(buildResponseCancel(nextEventId()));

        const destination = result.destination ?? '';
        const failRoute = (action: string, err: Error) => {
            log.error(`SDK_${action.toUpperCase()}_ERROR | destination=${destination} error="${err.message}"`);
            console.error(chalk.red(`[Seeduplex] ${action} error:`), err.message);
            // Release the lock so the caller can retry or hang up.
            routeState = 'idle';
            if (config.speakOnRouteFailure) {
                sendAssistantMessage(config.routeFailureUserReply);
            }
        };

        switch (result.action) {
            case 'transfer':
                log.info(`SDK_ACTION | transfer destination=${destination}`);
                console.log(chalk.magentaBright(`[Seeduplex] SDK transfer → ${destination}`));
                participant.transfer(destination)
                    .then(() => {
                        routeState = 'terminated';
                        stop();
                    })
                    .catch((err: Error) => failRoute('transfer', err));
                break;

            case 'drop':
                log.info('SDK_ACTION | drop');
                console.log(chalk.magentaBright('[Seeduplex] SDK drop'));
                participant.drop()
                    .then(() => {
                        routeState = 'terminated';
                        stop();
                    })
                    .catch((err: Error) => failRoute('drop', err));
                break;

            case 'transfer_voicemail':
                log.info(`SDK_ACTION | voicemail destination=${destination}`);
                console.log(chalk.magentaBright(`[Seeduplex] SDK transferToVoiceMail → ${destination}`));
                participant.transferToVoiceMail(destination)
                    .then(() => {
                        routeState = 'terminated';
                        stop();
                    })
                    .catch((err: Error) => failRoute('voicemail', err));
                break;

            default:
                routeState = 'idle';
                break;
        }
    };

    const sendAssistantMessage = (text: string) => {
        send(buildSpeechTextCommit(text, nextEventId(), randomUUID()));
    };

    const stop = (notifyServer = true) => {
        if (stopped) return;
        if (notifyServer && ws?.readyState === WebSocket.OPEN) {
            send(buildSessionClose(nextEventId()));
        }
        stopped = true;
        setPhase('closing');
        clearTimers();
        detachInputStream();
        audioMonitor?.dispose();
        audioMonitor = null;
        upsampler.reset();
        downsampler.reset();
        uplinkPacketizer.reset();
        pendingBatches.length = 0;
        try {
            // Permanent sink shutdown — only on call/bridge end, never on barge-in.
            audioWriter.cancel();
        } catch {
            // writer may already be cancelled
        }
        if (ws) {
            try {
                ws.removeAllListeners();
                ws.close();
            } catch {
                // ignore
            }
            ws = null;
        }
        setPhase('closed');
        log.info('BRIDGE_STOPPED');
        console.log(chalk.yellow('[Seeduplex] bridge stopped'));
    };

    const wsUrl = config.wsUrl ?? SEEDUPLEX_WS_URL;
    const headers = buildAuthHeaders(config.volcApiKey, config.volcAppId);

    log.info(`WS_CONNECT | url=${wsUrl}`);
    console.log(chalk.cyan(`[Seeduplex] connecting to ${wsUrl}`));

    ws = new WebSocket(wsUrl, { headers });

    // Ready timeout starts only after session.create is sent (inside sendSessionCreate).
    connectTimer = setTimeout(() => {
        if (phase === 'connecting') {
            log.error(`CONNECT_TIMEOUT | ms=${CONNECT_TIMEOUT_MS}`);
            console.error(chalk.red(`[Seeduplex] connect timeout after ${CONNECT_TIMEOUT_MS}ms`));
            stop();
        }
    }, CONNECT_TIMEOUT_MS);

    ws.on('upgrade', (res) => {
        log.info(`WS_UPGRADE | status=${res.statusCode}`);
    });

    ws.on('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
            body += chunk.toString();
        });
        res.on('end', () => {
            const status = res.statusCode ?? 0;
            log.error(`WS_REJECTED | status=${status} body=${body.substring(0, 300)}`);
            console.error(chalk.red(`[Seeduplex] WebSocket rejected: ${status} ${res.statusMessage}`));
            if (status === 401 || status === 403) {
                console.error(chalk.red('[Seeduplex] Auth/permission failed. Do NOT fall back to Seeduplex 1.0 binary API.'));
            }
            stop();
        });
    });

    ws.on('open', () => {
        if (stopped) return;
        if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
        }
        log.info('WS_OPEN');
        console.log(chalk.green('[Seeduplex] WebSocket connected'));
        // Open ≠ ready. Send session.create; media waits for session.created.
        sendSessionCreate();
    });

    ws.on('message', (data: WebSocket.RawData) => {
        if (stopped) return;
        const raw = data.toString();
        const event = parseJsonEvent(raw);
        if (!event) {
            log.error(`WS_PARSE_ERROR | preview="${raw.substring(0, 200)}"`);
            console.error(chalk.red('[Seeduplex] non-JSON message ignored'));
            return;
        }
        if (!event.type) {
            log.error(`WS_MESSAGE_WITHOUT_TYPE | preview="${raw.substring(0, 200)}"`);
            return;
        }
        handleEvent(event);
    });

    ws.on('close', (code, reason) => {
        log.info(`WS_CLOSE | code=${code} reason="${reason.toString()}"`);
        console.log(chalk.yellow(`[Seeduplex] WebSocket closed: ${code} ${reason.toString()}`));
        ws = null;
        if (!stopped) {
            stop();
        }
    });

    ws.on('error', (err) => {
        log.error(`WS_ERROR | error="${err.message}"`);
        console.error(chalk.red('[Seeduplex] WebSocket error:'), err.message);
    });

    return {
        stop,
        getPhase: () => phase,
        getDiagnostics: () => ({
            phase,
            routeState,
            outputEpoch,
            currentResponseId,
            cancelledResponseId,
            pendingToolCount: pendingBatches.reduce((count, batch) => count + batch.length, 0),
            toolDrainRunning,
            inputListenersRemoved,
        }),
    };
}

function createNoopLogger(): CallLogger {
    return {
        callId: 0,
        callStart() { },
        callEnd() { },
        systemPrompt() { },
        transcript() { },
        speechEvent() { },
        responseCreated() { },
        responseDone() { },
        ruleInjected() { },
        toolCalled() { },
        toolResult() { },
        info() { },
        warn() { },
        error() { },
        close() { },
    };
}
