# Tunnel resilience validation — 2026-10-03

Branch: `fix/tunnel-resilience`, based on local `origin/main` at `166d1a8`.

## Findings and changes

The eight-slot limiter already used owned semaphore permits and the framed
reader already had an abort-on-drop guard. The retention bug was in the
connection futures: TCP dialing had a deadline, but proxy Noise handshake and
authentication did not. A stalled peer could retain all slots indefinitely.
Tunnel writes and idle keep-alive sessions were also unbounded.

- Bound handshake/auth and individual writes to 5 seconds, and idle tunnels
  to 60 seconds. All terminal paths drop the Noise state, socket halves and
  owned permit. The host HTTP pool retains at most two idle connections for
  30 seconds; active streams still share the existing eight-slot limit.
- Retry each remote startup phase with 250 ms exponential backoff capped at
  2 seconds and a 30-second total deadline per phase. Only transport/proxy
  unavailability is retried; explicit refusals and validation failures stop.
  Show “Connecting to your node…” while pending, then a real failure on
  refusal/timeout. Retry reconstructs the proxy if initial bootstrap failed.
- Preserve typed `peer_not_ready` reasons (`chain_unavailable`, `not_synced`)
  across both price and first-contact quote paths. Show the named peer's chain
  connection reason under Send, keep Send disabled, and offer read-only retry.
  Existing string-valued quote IPC errors use a canonical reason marker;
  arbitrary prose is not interpreted as a typed refusal.

## Checks run

Dependency resolution was offline. No live node, port 3141, or external
network was contacted. Socket tests ran inside the existing restricted sandbox;
no socket permission escalation was requested.

- `npx vitest run`: **858 passed**, 54 files.
- `npm run build`: **passed** (TypeScript and Vite).
- `cargo test` in `src-tauri`: **262 passed, 62 failed**. All 62 failures
  reported `Operation not permitted` while creating test sockets. Cargo stopped
  at the library target, so this was not a successful full Rust suite.
- Targeted offline Rust regressions: **passed**. Four transport regressions,
  three startup-backoff regressions, typed proxy-refusal classification,
  typed peer-readiness propagation in the binary, and three existing framing /
  credential-stripping regressions (converted to in-memory streams).
- The restart/short-connection test opens 256 in-memory encrypted connections
  in batches of eight, alternating remote EOF, local EOF, invalid ciphertext,
  and task cancellation. After every batch, active slots return to **zero**
  and both endpoint stream halves close. Fresh Noise sessions successfully
  exchange data in the next batch. Additional tests cover silent handshake /
  auth, idle connections, and EOF during a blocked local write.
- New regressions reproduced the pre-fix failures before the fixes; targeted
  regressions and the full frontend suite passed afterward.
- Read-only code review found a terminal startup-state issue; fixed and
  re-reviewed. `git diff --check` passed.

A real remote-node restart and long-lived WebSocket heartbeat behavior were
not exercised against a live node, per the no-network constraint. An otherwise
silent WebSocket now expires at the idle deadline and uses the existing
reconnection path.

## Socket-blocked Rust tests

Every test below failed with sandbox `Operation not permitted`:

- `ai::tests::a_refusal_or_redirect_is_an_error_that_quotes_nothing`
- `ai::local::tests::probe_finds_openai_compatible_models`
- `ai::local::tests::ask_posts_chat_completions_on_loopback_only`
- `ai::local::tests::probe_finds_ollama_tags_on_loopback`
- `ai::tests::every_topic_reads_live_through_the_broker_with_freshness`
- `ai::local::tests::probe_skips_dead_ports_and_prefers_saved`
- `ai::tests::a_refused_token_or_a_dead_node_is_unavailable`
- `ai::tests::exact_is_the_broker_output_unchanged`
- `ai::tests::explicit_node_stale_survives_every_topic_and_disclosure_preset`
- `ai::tests::no_canary_reaches_a_read_or_any_disclosure`
- `ai::tests::node_as_of_headers_feed_freshness_and_stale_wins`
- `ai::tests::payments_counts_keeps_the_count_of_entries_only`
- `ai::tests::presets_form_a_chain_and_only_narrow`
- `ai::tests::remote_response_rejects_oversized_content_length_before_waiting_for_body`
- `ai::tests::rounded_and_counts_withhold_every_id_and_counts_every_amount`
- `ai::tests::the_balance_answer_is_the_node_figure`
- `ai::tests::the_body_carries_the_question_the_preset_and_the_fixed_instructions`
- `ai::tests::the_send_carries_exactly_the_disclosed_bytes_and_the_key`
- `ai::tests::without_a_paired_read_token_nothing_is_read`
- `ai::tests::without_node_as_of_a_live_read_is_unknown_not_fresh`
- `ai::tests::remote_response_caps_chunked_bytes_before_eof_or_json_parsing`
- `control::tests::ws_session_forwards_frames_from_a_loopback_socket`
- `ai::tests::remote_response_accepts_valid_json_up_to_the_byte_limit`
- `jarvis::assistant_feed::tests::a_live_feed_stamps_every_route_it_read`
- `jarvis::assistant_feed::tests::a_live_feed_reads_each_route_once`
- `jarvis::assistant_feed::tests::a_pairing_without_read_scope_is_not_paired_and_never_reads`
- `jarvis::assistant_feed::tests::a_route_that_drops_mid_read_is_mock`
- `jarvis::assistant_feed::tests::a_live_feed_with_a_failed_route_marks_only_that_route_unknown`
- `jarvis::assistant_feed::tests::fixture_over_loopback_matches_the_in_process_mock`
- `jarvis::assistant_feed::tests::an_unreachable_node_is_mock_with_a_reason`
- `jarvis::assistant_feed::tests::a_refused_token_is_not_paired`
- `jarvis::assistant_feed::tests::paired_and_healthy_is_live_with_node_values`
- `jarvis::assistant_feed::tests::rc7_fallback_is_mock_and_never_reads`
- `jarvis::assistant_feed::tests::remote_health_uses_authenticated_status_when_public_health_is_absent`
- `jarvis::assistant_feed::tests::every_mock_feed_has_no_freshness`
- `jarvis::assistant_feed::tests::not_paired_is_mock_and_never_reads`
- `jarvis::broker::freshness::tests::a_future_as_of_on_the_wire_never_claims_fresher_data`
- `jarvis::broker::freshness::tests::a_malformed_as_of_is_ignored_and_logged_without_its_value`
- `jarvis::broker::freshness::tests::a_node_as_of_sets_the_age_on_every_route`
- `jarvis::broker::freshness::tests::as_of_forms_on_the_wire_are_one_instant`
- `jarvis::broker::freshness::tests::data_stale_1_forces_stale_whatever_the_age`
- `jarvis::broker::freshness::tests::data_stale_other_than_1_has_no_effect`
- `jarvis::broker::freshness::tests::every_live_read_is_stamped_but_unmarked_data_stays_unknown`
- `jarvis::broker::freshness::tests::headers_on_an_error_response_are_ignored`
- `jarvis::broker::freshness::tests::only_messages_carry_a_node_time`
- `jarvis::broker::freshness::tests::unusable_as_of_never_claims_freshness`
- `jarvis::broker::freshness::tests::without_headers_every_route_keeps_freshness_unknown`
- `jarvis::broker::local_read::tests::a_closed_connection_is_a_transport_fault`
- `jarvis::broker::local_read::tests::a_node_error_status_is_returned_as_a_status_not_a_fault`
- `jarvis::broker::local_read::tests::a_wrong_token_is_a_401_status`
- `jarvis::broker::local_read::tests::accepts_only_http_loopback_ip_bases_with_the_api_prefix`
- `jarvis::broker::local_read::tests::an_unreachable_node_is_a_transport_fault`
- `jarvis::broker::local_read::tests::denied_path_in_the_log_is_bounded_and_printable`
- `jarvis::broker::local_read::tests::reads_an_allowlisted_route_with_the_paired_token`
- `jarvis::broker::local_read::tests::remote_reader_adds_the_process_proxy_credential`
- `jarvis::broker::local_read::tests::the_token_never_appears_in_logs_errors_or_debug`
- `jarvis::broker::local_read::tests::write_and_unlisted_requests_never_reach_the_node_and_are_logged`
- `jarvis::broker::payments_tests::over_loopback_the_mock_node_leaks_no_canary`
- `remote_access::tests::proxy_caps_authenticated_local_connections`
- `remote_access::tests::silent_pre_auth_close_returns_stable_http_status`
- `remote_access::tests::fresh_import_bootstraps_pinned_noise_before_remote_establish`
- `remote_access::tests::noise_pin_succeeds_and_mismatch_is_required_refusal`
