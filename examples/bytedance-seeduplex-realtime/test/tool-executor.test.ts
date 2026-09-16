import assert from 'node:assert/strict';
import test from 'node:test';
import type { Participant } from '@3cx/call-control-sdk';
import { createCallState } from '../src/agent/call-state.ts';
import { createToolExecutor } from '../src/agent/tool-executor.ts';

test('resumes a transfer after sequential screening tools complete', async () => {
    const attachedScreening: Record<string, unknown>[] = [];
    const participant = {
        attachPartyData: async (data: Record<string, unknown>) => {
            attachedScreening.push(data);
        },
    } as unknown as Participant;
    const callState = createCallState('', '1000');
    const executor = createToolExecutor({
        participant,
        profile: {
            role: 'receptionist',
            prompt: '',
            greeting: '',
            callScreening: true,
            checkAvailability: false,
        },
        callState,
        onCleanup: () => undefined,
    });

    const blocked = await executor.execute('transfer_call', JSON.stringify({ destination: '803' }));
    assert.equal(blocked.action, undefined);
    assert.match(blocked.content, /ask the caller for: name, company, reason/);

    const name = await executor.execute('save_caller_name', JSON.stringify({ name: 'Lin Tony' }));
    assert.equal(name.action, undefined);
    const company = await executor.execute('save_caller_company', JSON.stringify({ company: '3CX China' }));
    assert.equal(company.action, undefined);

    const reason = await executor.execute(
        'save_caller_reason',
        JSON.stringify({ reason: 'Test Seeduplex transfer' }),
    );
    assert.equal(reason.action, 'transfer');
    assert.equal(reason.destination, '803');
    assert.equal(attachedScreening.length, 1);
});
