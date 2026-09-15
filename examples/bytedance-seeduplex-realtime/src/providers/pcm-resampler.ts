/**
 * Stateful mono 16-bit LE PCM resampler.
 *
 * WebSocket frames are not sample-aligned. Partial samples (1 leftover byte)
 * and phase must be carried across chunk boundaries.
 */

export type UplinkRemainder = { byte: number } | null;

/**
 * Upsample 8 kHz → 16 kHz by sample duplication (2×).
 * Keeps a 1-byte remainder across chunks so odd-sized frames do not drop a sample.
 */
export class PcmUpsampler8kTo16k {
    private remainder: UplinkRemainder = null;

    reset(): void {
        this.remainder = null;
    }

    process(chunk: Buffer): Buffer {
        let input: Buffer;
        if (this.remainder && chunk.length > 0) {
            input = Buffer.concat([Buffer.from([this.remainder.byte]), chunk]);
            this.remainder = null;
        } else if (this.remainder) {
            input = Buffer.from([this.remainder.byte]);
            this.remainder = null;
        } else {
            input = chunk;
        }

        if (input.length % 2 === 1) {
            this.remainder = { byte: input[input.length - 1] };
            input = input.subarray(0, input.length - 1);
        }

        const samples = input.length / 2;
        if (samples === 0) return Buffer.alloc(0);

        const out = Buffer.allocUnsafe(samples * 4);
        for (let i = 0; i < samples; i++) {
            const s = input.readInt16LE(i * 2);
            out.writeInt16LE(s, i * 4);
            out.writeInt16LE(s, i * 4 + 2);
        }
        return out;
    }
}

/**
 * Downsample 24 kHz → 8 kHz using a stateful 3-sample boxcar low-pass filter.
 *
 * The filter is deliberately small (0.125 ms of input) to keep conversational
 * latency negligible while suppressing the strongest aliases before 3:1
 * decimation. Partial samples and filter groups are preserved across chunks.
 */
export class PcmDownsampler24kTo8k {
    private remainder: UplinkRemainder = null;
    private filterSum = 0;
    private filterSamples = 0;

    reset(): void {
        this.remainder = null;
        this.filterSum = 0;
        this.filterSamples = 0;
    }

    process(chunk: Buffer): Buffer {
        let input: Buffer;
        if (this.remainder && chunk.length > 0) {
            input = Buffer.concat([Buffer.from([this.remainder.byte]), chunk]);
            this.remainder = null;
        } else if (this.remainder) {
            input = Buffer.from([this.remainder.byte]);
            this.remainder = null;
        } else {
            input = chunk;
        }

        if (input.length % 2 === 1) {
            this.remainder = { byte: input[input.length - 1] };
            input = input.subarray(0, input.length - 1);
        }

        const inSamples = input.length / 2;
        const outBytes: number[] = [];

        for (let i = 0; i < inSamples; i++) {
            this.filterSum += input.readInt16LE(i * 2);
            this.filterSamples += 1;
            if (this.filterSamples === 3) {
                const sample = Math.round(this.filterSum / 3);
                outBytes.push(sample & 0xff, (sample >> 8) & 0xff);
                this.filterSum = 0;
                this.filterSamples = 0;
            }
        }

        if (outBytes.length === 0) return Buffer.alloc(0);
        return Buffer.from(outBytes);
    }
}

/** Collects arbitrary PCM chunks into fixed-size frames without losing bytes. */
export class PcmFramePacketizer {
    private pending = Buffer.alloc(0);
    private readonly frameBytes: number;

    constructor(frameBytes: number) {
        if (!Number.isInteger(frameBytes) || frameBytes <= 0) {
            throw new Error('frameBytes must be a positive integer');
        }
        this.frameBytes = frameBytes;
    }

    reset(): void {
        this.pending = Buffer.alloc(0);
    }

    process(chunk: Buffer): Buffer[] {
        if (chunk.length === 0) return [];
        this.pending = this.pending.length === 0
            ? Buffer.from(chunk)
            : Buffer.concat([this.pending, chunk]);

        const frames: Buffer[] = [];
        while (this.pending.length >= this.frameBytes) {
            frames.push(this.pending.subarray(0, this.frameBytes));
            this.pending = this.pending.subarray(this.frameBytes);
        }
        return frames;
    }
}

/** Continuous-tone check: 1s @ 8k (16000 bytes) → 32000 bytes at 16k. */
export function expectedUpsampleBytes(inputBytes: number): number {
    const complete = Math.floor(inputBytes / 2);
    return complete * 4;
}

/** Continuous-tone check: 1s @ 24k (48000 bytes) → 16000 bytes at 8k. */
export function expectedDownsampleBytes(inputBytes: number): number {
    const complete = Math.floor(inputBytes / 2);
    return Math.floor(complete / 3) * 2;
}
