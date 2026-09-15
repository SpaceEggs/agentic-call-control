import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateConfig, DEFAULT_REALTIME_MODEL, DEFAULT_REALTIME_VOICE } from '../src/app-config.ts';
import type { AppConfig } from '../src/app-config.ts';

const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = join(here, '..');

function baseConfig(): AppConfig {
    return {
        appId: '3cx-app',
        appSecret: 'secret',
        pbxBase: 'https://pbx.example:5001',
        volcAppId: 'volc-app',
        volcApiKey: 'volc-key',
        initialGreeting: '您好',
        speakOnRouteFailure: true,
        routeFailureUserReply: '转接失败',
    };
}

test('T01 valid config passes', () => {
    validateConfig(baseConfig());
});

test('T01 missing volc fields lists names only, no secrets', () => {
    const cfg = baseConfig();
    // @ts-expect-error intentional empty
    cfg.volcAppId = '';
    cfg.volcApiKey = '   ';
    try {
        validateConfig(cfg);
        assert.fail('expected throw');
    } catch (err) {
        const msg = (err as Error).message;
        assert.ok(msg.includes('volcAppId'));
        assert.ok(msg.includes('volcApiKey'));
        assert.ok(!msg.includes('secret'));
        assert.ok(!msg.includes('volc-key'));
    }
});

test('T01 appId and volcAppId are independent fields', () => {
    const cfg = baseConfig();
    // @ts-expect-error intentional empty
    cfg.appId = '';
    try {
        validateConfig(cfg);
        assert.fail('expected throw');
    } catch (err) {
        assert.ok((err as Error).message.includes('appId'));
        assert.ok(!(err as Error).message.includes('volcAppId'));
    }
});

test('defaults are issue-specified model and Chinese voice', () => {
    assert.equal(DEFAULT_REALTIME_MODEL, '1.2.6.0');
    assert.equal(DEFAULT_REALTIME_VOICE, 'zh_female_vv_jupiter_bigtts');
});

test('config.yaml.example has no Qwen/DashScope credentials', () => {
    const example = join(exampleRoot, 'config.yaml.example');
    assert.ok(existsSync(example));
    const raw = readFileSync(example, 'utf-8');
    assert.ok(!raw.includes('dashscopeApiKey'));
    assert.ok(!raw.includes('dashscopeBaseUrl'));
    assert.ok(!raw.includes('gummy-realtime-v1'));
    assert.ok(raw.includes('volcAppId'));
    assert.ok(raw.includes('volcApiKey'));
    assert.ok(raw.includes('1.2.6.0'));
});

test('package name and no openai dependency', () => {
    const pkg = JSON.parse(readFileSync(join(exampleRoot, 'package.json'), 'utf-8'));
    assert.equal(pkg.name, '@3cx-examples/bytedance-seeduplex-realtime');
    assert.equal(pkg.dependencies.openai, undefined);
    assert.ok(pkg.scripts.test);
});
