import assert from 'node:assert/strict';
import test from 'node:test';
import type { CallParticipant } from '@3cx/call-control-sdk';
import { resolveRemoteCallerNumber } from './call-state.ts';

test('caller number uses caller ID when it is not the programmable DN', () => {
    const info: CallParticipant = {
        dn: '9646',
        party_caller_id: '+86 13800138000',
        party_dn: '1001',
    };
    assert.equal(resolveRemoteCallerNumber(info, '9646'), '+86 13800138000');
});

test('caller number falls back to the remote party DN when caller ID is the programmable DN', () => {
    const info: CallParticipant = {
        dn: '9646',
        party_caller_id: '9646',
        party_dn: '+86 13800138000',
    };
    assert.equal(resolveRemoteCallerNumber(info, '9646'), '+86 13800138000');
});

test('caller number is unavailable rather than returning the programmable DN', () => {
    const info: CallParticipant = {
        dn: '9646',
        party_caller_id: '9646',
        party_dn: '9646',
    };
    assert.equal(resolveRemoteCallerNumber(info, '9646'), '');
});
