/** Read-only projection of node #373; no hub identity or routing input. */
export type StarterStatus = {
  state: 'not_requested' | 'requested' | 'opening' | 'ready' | 'refused';
  hub_configured: boolean;
  hub_alias?: string | null;
  request_id?: string | null;
  detail?: string | null;
  verified?: boolean;
  push_sats?: number | null;
  retry_allowed?: boolean;
  retry_after_unix?: number | null;
};
export type StarterApi = {
  current(): Promise<StarterStatus>;
  request(requestId: string): Promise<StarterStatus>;
};
