import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    PcmUpsampler8kTo16k,
    PcmDownsampler24kTo8k,
    PcmFramePacketizer,
    expectedUpsampleBytes,
    expectedDownsampleBytes,
} from '../src/providers/pcm-resampler.ts';

function sinePcm16le(samples: number, freq = 440, rate = 8000): Buffer {
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
        const s = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000);
        buf.writeInt16LE(s, i * 2);
    }
    return buf;
}

test('1s of 8 kHz audio (16000 bytes) upsamples to 32000 bytes', () => {
    const up = new PcmUpsampler8kTo16k();
    const input = sinePcm16le(8000);
    assert.equal(input.length, 16000);
    const out = up.process(input);
    assert.equal(out.length, 32000);
    assert.equal(out.length, expectedUpsampleBytes(input.length));
});

test('1s of 24 kHz audio (48000 bytes) downsamples to 16000 bytes', () => {
    const down = new PcmDownsampler24kTo8k();
    const input = sinePcm16le(24000, 440, 24000);
    assert.equal(input.length, 48000);
    const out = down.process(input);
    assert.equal(out.length, 16000);
    assert.equal(out.length, expectedDownsampleBytes(input.length));
});

test('upsample chunked == whole buffer (including odd byte remainder)', () => {
    const up = new PcmUpsampler8kTo16k();
    const input = sinePcm16le(1000);
    // Append one leftover byte so the next process sees a partial sample.
    const withOdd = Buffer.concat([input, Buffer.from([0x34])]);

    const up2 = new PcmUpsampler8kTo16k();
    const whole = up2.process(withOdd);

    up.reset();
    const chunks: Buffer[] = [];
    for (let i = 0; i < withOdd.length; i += 7) {
        chunks.push(up.process(withOdd.subarray(i, i + 7)));
    }
    const chunked = Buffer.concat(chunks);
    assert.equal(chunked.length, whole.length);
    assert.ok(chunked.equals(whole));
});

test('downsample chunked == whole buffer (phase preserved across frames)', () => {
    const input = sinePcm16le(2400, 440, 24000);

    const downWhole = new PcmDownsampler24kTo8k();
    const whole = downWhole.process(input);

    const downChunked = new PcmDownsampler24kTo8k();
    const parts: Buffer[] = [];
    for (let i = 0; i < input.length; i += 10) {
        parts.push(downChunked.process(input.subarray(i, i + 10)));
    }
    const chunked = Buffer.concat(parts);
    assert.equal(chunked.length, whole.length);
    assert.ok(chunked.equals(whole), 'chunked downsample must match whole-buffer downsample');
});

test('reset clears remainder and phase so old audio is not mixed into a new response', () => {
    const down = new PcmDownsampler24kTo8k();
    down.process(Buffer.from([0x01, 0x02, 0x03])); // odd byte remainder
    down.reset();
    const next = down.process(sinePcm16le(30, 440, 24000));
    // After reset, the first output is the average of the first three new samples.
    assert.ok(next.length > 0);
    const fresh = sinePcm16le(30, 440, 24000);
    const expectedFirst = Math.round(
        (fresh.readInt16LE(0) + fresh.readInt16LE(2) + fresh.readInt16LE(4)) / 3,
    );
    assert.equal(next.readInt16LE(0), expectedFirst);
});

test('upsample duplicates each sample', () => {
    const up = new PcmUpsampler8kTo16k();
    const input = Buffer.alloc(4);
    input.writeInt16LE(1000, 0);
    input.writeInt16LE(-2000, 2);
    const out = up.process(input);
    assert.equal(out.length, 8);
    assert.equal(out.readInt16LE(0), 1000);
    assert.equal(out.readInt16LE(2), 1000);
    assert.equal(out.readInt16LE(4), -2000);
    assert.equal(out.readInt16LE(6), -2000);
});

test('downsample anti-alias filter suppresses an 8 kHz input tone', () => {
    const down = new PcmDownsampler24kTo8k();
    const out = down.process(sinePcm16le(2400, 8000, 24000));
    let peak = 0;
    for (let offset = 0; offset < out.length; offset += 2) {
        peak = Math.max(peak, Math.abs(out.readInt16LE(offset)));
    }
    assert.ok(peak < 10, `8 kHz alias peak should be suppressed, got ${peak}`);
});

test('20 ms uplink packetizer emits exact 640-byte frames across chunk boundaries', () => {
    const packetizer = new PcmFramePacketizer(640);
    assert.deepEqual(packetizer.process(Buffer.alloc(639)), []);
    const first = packetizer.process(Buffer.alloc(2));
    assert.equal(first.length, 1);
    assert.equal(first[0].length, 640);
    const next = packetizer.process(Buffer.alloc(1279));
    assert.equal(next.length, 2);
    assert.ok(next.every((frame) => frame.length === 640));
    packetizer.reset();
    assert.deepEqual(packetizer.process(Buffer.alloc(639)), []);
});
