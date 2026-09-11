import type { CallParticipant } from '@3cx/call-control-sdk';

export interface CallerInfo {
    name: string;
    number: string;
}

export interface CallScreening {
    name?: string;
    company?: string;
    reason?: string;
    tone?: string;
}

export interface PhonebookContact {
    extensionNumber: string;
    displayName: string;
    isAvailable?: boolean;
}

export interface DeskTicketState {
    issueKey: string;
    ticketId?: string;
    ticketNumber?: string;
}

export interface CallState {
    callerInfo: CallerInfo;
    screening: CallScreening;
    pendingRoute?: PhonebookContact;
    deskTicket?: DeskTicketState;
}

export function createCallState(callerName: string, callerNumber: string): CallState {
    return {
        callerInfo: { name: callerName, number: callerNumber },
        screening: {},
    };
}

export function resolveRemoteCallerNumber(info: CallParticipant, ownDn: string): string {
    const localNumbers = new Set([
        ownDn.trim(),
        String(info.dn ?? '').trim(),
    ].filter(Boolean));
    const callerId = String(info.party_caller_id ?? '').trim();
    if (callerId && !localNumbers.has(callerId)) return callerId;
    const partyDn = String(info.party_dn ?? '').trim();
    if (partyDn && !localNumbers.has(partyDn)) return partyDn;
    return '';
}

export function formatScreening(s: CallScreening): string {
    return `Name: ${s.name ?? 'unknown'}, Company: ${s.company ?? 'unknown'}, Reason: ${s.reason ?? 'unknown'}, Tone: ${s.tone ?? 'neutral'}`;
}

export function isScreeningReady(s: CallScreening): boolean {
    return !!s.name && !!s.company && !!s.reason;
}

export function missingScreeningFields(s: CallScreening): string[] {
    const missing: string[] = [];
    if (!s.name) missing.push('name');
    if (!s.company) missing.push('company');
    if (!s.reason) missing.push('reason');
    return missing;
}
