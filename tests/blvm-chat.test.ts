import { describe, expect, it } from 'vitest';
import { chatAmountError, chatRecipientError, chatRequestIdError, chatScriptError, chatTxError } from '../src/control/blvmChat';

describe('on-chain chat owner fields', () => {
  it('accepts a payable amount and rejects an empty or unsafe one', () => {
    expect(chatAmountError(1)).toBeNull();
    expect(chatAmountError(0)).toMatch(/outside the chat session range/);
    expect(chatAmountError(1.5)).toMatch(/outside the chat session range/);
    expect(chatAmountError(Number.MAX_SAFE_INTEGER + 1)).toMatch(/outside the chat session range/);
  });

  it('accepts script, recipient, request id, and tx only in the node shape', () => {
    expect(chatScriptError('51')).toBeNull();
    expect(chatScriptError('zz')).toMatch(/not hex/);
    expect(chatScriptError('')).toMatch(/not hex/);
    expect(chatRecipientError('ab'.repeat(32))).toBeNull();
    expect(chatRecipientError('ab')).toMatch(/not a node id/);
    expect(chatRequestIdError('req-1')).toBeNull();
    expect(chatRequestIdError('req 1')).toMatch(/invalid/);
    expect(chatTxError('aa'.repeat(32))).toBeNull();
    expect(chatTxError('abcd')).toMatch(/32 bytes/);
  });
});
