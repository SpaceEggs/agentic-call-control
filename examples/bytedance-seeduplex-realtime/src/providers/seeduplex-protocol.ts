/** Seeduplex 3.0 full-duplex text-JSON protocol helpers. */

export const SEEDUPLEX_WS_URL =
    'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue';

export const AUTH_HEADER_API_KEY = 'X-Api-Key';
export const AUTH_HEADER_APP_ID = 'X-Api-App-Id';

export const EVENT = {
    sessionCreate: 'session.create',
    sessionUpdate: 'session.update',
    sessionClose: 'session.close',
    sessionCreated: 'session.created',
    sessionUpdated: 'session.updated',
    sessionClosed: 'session.closed',
    inputAudioAppend: 'input_audio_buffer.append',
    outputAudioStarted: 'response.output_audio.started',
    outputAudioDelta: 'response.output_audio.delta',
    outputAudioDone: 'response.output_audio.done',
    speechTextCommit: 'speech_text_buffer.commit',
    functionCallArgumentsDone: 'response.function_call_arguments.done',
    conversationItemCreate: 'conversation.item.create',
    inputAudioTranscriptionStarted: 'conversation.item.input_audio_transcription.started',
    inputAudioTranscriptionDelta: 'conversation.item.input_audio_transcription.delta',
    inputAudioTranscriptionCompleted: 'conversation.item.input_audio_transcription.completed',
    outputTextDelta: 'response.output_text.delta',
    outputTextDone: 'response.output_text.done',
    responseCancel: 'response.cancel',
    responseCanceled: 'response.canceled',
    responseDone: 'response.done',
    error: 'error',
} as const;

export type SeeduplexEventName = (typeof EVENT)[keyof typeof EVENT];

export const RATE_3CX_HZ = 8000;
export const RATE_UPLINK_HZ = 16000;
export const RATE_DOWNLINK_HZ = 24000;
export const UPLINK_FRAME_BYTES = 640; // 20 ms, 16 kHz, mono PCM16LE

export type SeeduplexAuthHeaders = Record<string, string>;

/**
 * The official 2026-08 demo requires X-Api-Key. Issue #2 additionally requires
 * X-Api-App-Id, so it is retained for compatibility with provisioned accounts.
 */
export function buildAuthHeaders(apiKey: string, appId: string): SeeduplexAuthHeaders {
    return {
        [AUTH_HEADER_API_KEY]: apiKey,
        [AUTH_HEADER_APP_ID]: appId,
    };
}

export interface SeeduplexToolWire {
    type: 'function';
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface SessionCreateOptions {
    sessionId: string;
    eventId: string;
    model: string;
    voice: string;
    instructions: string;
    inputSampleRate: typeof RATE_UPLINK_HZ;
    outputSampleRate: typeof RATE_DOWNLINK_HZ;
    tools: SeeduplexToolWire[];
}

/** Exact layout from the official Go/Python 3.0 duplex demos (2026-08-07). */
export function buildSessionCreate(opts: SessionCreateOptions): Record<string, unknown> {
    return {
        type: EVENT.sessionCreate,
        event_id: opts.eventId,
        session: {
            id: opts.sessionId,
            model: opts.model,
            instructions: opts.instructions,
            audio: {
                input: {
                    format: { type: 'pcm', rate: opts.inputSampleRate },
                },
                output: {
                    format: { type: 'pcm_s16le', rate: opts.outputSampleRate },
                    voice: opts.voice,
                },
            },
            tools: opts.tools,
        },
        extension: {
            asr: {},
            tts: {},
            dialog: {},
        },
    };
}

export function buildInputAudioAppend(pcmBase64: string): Record<string, unknown> {
    return { type: EVENT.inputAudioAppend, audio: pcmBase64 };
}

export function buildSpeechTextCommit(
    text: string,
    eventId: string,
    speechId: string,
): Record<string, unknown> {
    return {
        type: EVENT.speechTextCommit,
        event_id: eventId,
        speech_id: speechId,
        text,
    };
}

export function buildResponseCancel(eventId: string): Record<string, unknown> {
    return { type: EVENT.responseCancel, event_id: eventId };
}

export function buildSessionClose(eventId: string): Record<string, unknown> {
    return { type: EVENT.sessionClose, event_id: eventId };
}

export interface SeeduplexToolResult {
    callId: string;
    output: string;
}

/** Official tool-result envelope: one event with an items array. */
export function buildToolResultItems(
    results: SeeduplexToolResult[],
    eventId: string,
): Record<string, unknown> {
    return {
        type: EVENT.conversationItemCreate,
        event_id: eventId,
        items: results.map(({ callId, output }) => ({
            type: 'message',
            role: 'tool',
            call_id: callId,
            content: [{ type: 'input_text', text: output }],
        })),
    };
}

export interface ParsedFunctionCallItem {
    callId: string;
    name: string;
    arguments: string | Record<string, unknown>;
}

export function parseFunctionCallItems(event: Record<string, unknown>): ParsedFunctionCallItem[] {
    const items = event.items;
    if (!Array.isArray(items)) return [];

    const out: ParsedFunctionCallItem[] = [];
    for (const raw of items) {
        if (raw === null || typeof raw !== 'object') continue;
        const item = raw as Record<string, unknown>;
        const callId = typeof item.call_id === 'string' ? item.call_id : undefined;
        const name = typeof item.name === 'string' ? item.name : undefined;
        if (!callId || !name) continue;

        const args = item.arguments;
        if (typeof args === 'string') {
            out.push({ callId, name, arguments: args });
        } else if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
            // Tolerate object arguments even though the official demo emits JSON text.
            out.push({ callId, name, arguments: args as Record<string, unknown> });
        } else {
            out.push({ callId, name, arguments: '{}' });
        }
    }
    return out;
}

export function argumentsToJson(args: string | Record<string, unknown>): string {
    if (typeof args === 'string') {
        const parsed = JSON.parse(args) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('tool arguments must be a JSON object');
        }
        return args;
    }
    return JSON.stringify(args);
}

export function parseJsonEvent(raw: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

export function extractResponseId(event: Record<string, unknown>): string | undefined {
    return typeof event.response_id === 'string' && event.response_id
        ? event.response_id
        : undefined;
}

export function extractOutputAudioBase64(event: Record<string, unknown>): string | null {
    return typeof event.delta === 'string' && event.delta.length > 0 ? event.delta : null;
}

export function extractServerError(event: Record<string, unknown>): {
    code: string;
    message: string;
} {
    const error = event.error;
    if (error !== null && typeof error === 'object') {
        const record = error as Record<string, unknown>;
        return {
            code: String(record.code ?? record.type ?? 'unknown'),
            message: String(record.message ?? 'Unknown Seeduplex error'),
        };
    }
    return {
        code: String(event.code ?? event.error_code ?? 'unknown'),
        message: String(event.message ?? event.error_message ?? 'Unknown Seeduplex error'),
    };
}
