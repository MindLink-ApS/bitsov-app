/** Owner fields for an outbound BLVM chat session. The node verifies the payment. */

export type BlvmChatRequest = { payment_request_id: string };

export type BlvmChatSession = {
  recipient: string;
  payment_request_id: string;
  tx_hash: string;
  amount_sats: number;
  debit_counter: number;
  spent_msat: number;
  remaining_msat: number;
};

const MAX_SATS = Number.MAX_SAFE_INTEGER;

export function chatAmountError(amount: number): string | null {
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_SATS) {
    return 'amount_sats is outside the chat session range';
  }
  return null;
}

export function chatScriptError(script: string): string | null {
  const text = script.trim();
  if (text.length === 0 || text.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(text)) {
    return 'script_pubkey_hex is not hex';
  }
  const bytes = text.length / 2;
  if (bytes < 1 || bytes > 10_000) return 'script_pubkey_hex is outside the script length range';
  return null;
}

export function chatRecipientError(recipient: string): string | null {
  if (!/^[0-9a-fA-F]{64}$/.test(recipient.trim())) return 'recipient is not a node id';
  return null;
}

export function chatRequestIdError(id: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id.trim())) return 'payment_request_id is invalid';
  return null;
}

export function chatTxError(tx: string): string | null {
  if (!/^[0-9a-fA-F]{64}$/.test(tx.trim())) return 'tx_hash must be 32 bytes';
  return null;
}
