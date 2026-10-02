# Test #5 run 2 app fixes — offline verification

Branch: `fix/test5-run2`, based on `origin/main` at `c268bbd`.
Findings: TEST5-SANITY-LOG.md, Atlas run 2 items 15–20.

## Behavior

- Spend and budget action errors have separate storage from poll errors. Polls do not erase a refused approval; a new action or newly open approval clears it.
- Calls end on rejected signalling, release media, and display the error. A signal that never returns ends the renderer wait after 30 seconds with an **unknown payment outcome**, never a retry or a claim that nothing was paid. A late receipt cannot restart the call. A cancelled call's rejected operation cannot end a newer incoming call.
- Trust acknowledgement survives relaunch, scoped to node identity and local/remote mode. Temporary status failure preserves the acknowledged shell. New identities/modes still require the disclosure. Existing installations without a saved acknowledgement require one acceptance with this build; subsequent launches enter the main shell. Before setup, the sidebar reports room availability as unknown rather than unsupported; the active shell uses `room_binding_v1` from the node overview.
- An optional `/peers` `ln_pubkey` is preserved by the host and maps channel keys to local contact names. Missing or ambiguous mappings retain the unnamed fallback. No mapping was inferred from labels, order, or amounts; the locally available node source does not expose this field, so those nodes keep the fallback until they report it.
- Shared amount formatting honors Sats/BTC, including exact fractional sats and locale decimal separators. Preset selection is stored per node as a preference, never as spending authority.

## Frontend

- `npm_config_offline=true npx vitest run`: **853 passed**, 54 files.
- `npm run build`: **passed** (TypeScript and Vite).
- `git diff --check`: **passed**.
- Restoring the old spend polling error slot made the new sticky-error test fail; restoring the fix made it pass.
- Read-only code review found three state/lifetime edge cases; all were reproduced, fixed, and re-reviewed.
- Existing Solid test warnings about computations outside a root were printed; there were no failing frontend tests in the final suite.

## Rust

All commands used `CARGO_NET_OFFLINE=true`, `--offline`, and
`CARGO_TARGET_DIR=/private/tmp/app-fd-editor-target`. A pre-existing local sidecar
was copied into the ignored `src-tauri/bin` directory solely because Tauri's
build script requires the resource. The sidecar was not launched. No live node
or port 3141 was contacted. Mock socket tests could not bind in this sandbox;
no network access was enabled to bypass that restriction.

| Command after `cargo test --offline --manifest-path src-tauri/Cargo.toml` | Result |
| --- | --- |
| `--no-run` | All default test targets compiled |
| `--lib` | 251 passed; 65 blocked by socket permission errors |
| `--bin bitsov-app` | 85 passed; 217 environment failures; 1 ignored |
| `-p bitsov-app --test onboarding_assistant --test pairing --test pr47_budget --no-fail-fast` | Pairing: 3 passed, 10 blocked by sockets; budget: 2 passed; onboarding feature-gated (0 tests) |
| `-p bitsov-app --features sit-mock --test onboarding_assistant` | 4 blocked by sockets |
| `-p mock-node --no-fail-fast` | 27 passed across canaries, determinism, fixture, pairing, routes; doc tests passed (0 tests) |

Binary environment failures comprise 202 socket permission errors, six Secure
Enclave unavailable checks, eight nested `sandbox-exec` permission failures,
and `model_launch::macos::tests::launch_denies_network` whose unconfined socket
control is also denied. These suites are **not claimed green**.

The new host mapping round-trip test passed. The new host call-refusal test
compiled, but its mock listener was blocked; it did not exercise the refusal
handler here. Renderer refusal, teardown, timeout, denomination, relaunch,
preset and mapping regressions passed without sockets.

The node-side remote elevation-route and quote-scope blockers from item 15
remain outside this app change. No grant, payment, cloud operation, push, or
live paid-run validation was performed.

## Environment-blocked Rust tests

The following lists preserve the exact failed test names from the attempted
suites, so the remaining runtime validation can be repeated outside this sandbox.

### lib (65)

- `ai::tests::a_refusal_or_redirect_is_an_error_that_quotes_nothing`
- `ai::local::tests::ask_posts_chat_completions_on_loopback_only`
- `ai::local::tests::probe_finds_openai_compatible_models`
- `ai::local::tests::probe_skips_dead_ports_and_prefers_saved`
- `ai::tests::every_topic_reads_live_through_the_broker_with_freshness`
- `ai::tests::a_refused_token_or_a_dead_node_is_unavailable`
- `ai::local::tests::probe_finds_ollama_tags_on_loopback`
- `ai::tests::exact_is_the_broker_output_unchanged`
- `ai::tests::no_canary_reaches_a_read_or_any_disclosure`
- `ai::tests::explicit_node_stale_survives_every_topic_and_disclosure_preset`
- `ai::tests::node_as_of_headers_feed_freshness_and_stale_wins`
- `ai::tests::payments_counts_keeps_the_count_of_entries_only`
- `ai::tests::presets_form_a_chain_and_only_narrow`
- `ai::tests::remote_response_rejects_oversized_content_length_before_waiting_for_body`
- `ai::tests::rounded_and_counts_withhold_every_id_and_counts_every_amount`
- `ai::tests::the_body_carries_the_question_the_preset_and_the_fixed_instructions`
- `ai::tests::the_send_carries_exactly_the_disclosed_bytes_and_the_key`
- `ai::tests::without_node_as_of_a_live_read_is_unknown_not_fresh`
- `ai::tests::the_balance_answer_is_the_node_figure`
- `ai::tests::without_a_paired_read_token_nothing_is_read`
- `ai::tests::remote_response_caps_chunked_bytes_before_eof_or_json_parsing`
- `control::tests::ws_session_forwards_frames_from_a_loopback_socket`
- `ai::tests::remote_response_accepts_valid_json_up_to_the_byte_limit`
- `jarvis::assistant_feed::tests::a_live_feed_reads_each_route_once`
- `jarvis::assistant_feed::tests::a_live_feed_stamps_every_route_it_read`
- `jarvis::assistant_feed::tests::a_live_feed_with_a_failed_route_marks_only_that_route_unknown`
- `jarvis::assistant_feed::tests::a_pairing_without_read_scope_is_not_paired_and_never_reads`
- `jarvis::assistant_feed::tests::a_refused_token_is_not_paired`
- `jarvis::assistant_feed::tests::a_route_that_drops_mid_read_is_mock`
- `jarvis::assistant_feed::tests::an_unreachable_node_is_mock_with_a_reason`
- `jarvis::assistant_feed::tests::not_paired_is_mock_and_never_reads`
- `jarvis::assistant_feed::tests::fixture_over_loopback_matches_the_in_process_mock`
- `jarvis::assistant_feed::tests::paired_and_healthy_is_live_with_node_values`
- `jarvis::assistant_feed::tests::rc7_fallback_is_mock_and_never_reads`
- `jarvis::assistant_feed::tests::every_mock_feed_has_no_freshness`
- `jarvis::assistant_feed::tests::remote_health_uses_authenticated_status_when_public_health_is_absent`
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
- `jarvis::broker::local_read::tests::a_wrong_token_is_a_401_status`
- `jarvis::broker::local_read::tests::accepts_only_http_loopback_ip_bases_with_the_api_prefix`
- `jarvis::broker::local_read::tests::a_node_error_status_is_returned_as_a_status_not_a_fault`
- `jarvis::broker::local_read::tests::denied_path_in_the_log_is_bounded_and_printable`
- `jarvis::broker::local_read::tests::reads_an_allowlisted_route_with_the_paired_token`
- `jarvis::broker::local_read::tests::remote_reader_adds_the_process_proxy_credential`
- `jarvis::broker::local_read::tests::the_token_never_appears_in_logs_errors_or_debug`
- `jarvis::broker::local_read::tests::write_and_unlisted_requests_never_reach_the_node_and_are_logged`
- `jarvis::broker::local_read::tests::an_unreachable_node_is_a_transport_fault`
- `jarvis::broker::payments_tests::over_loopback_the_mock_node_leaks_no_canary`
- `remote_access::tests::fresh_import_bootstraps_pinned_noise_before_remote_establish`
- `remote_access::tests::proxy_caps_authenticated_local_connections`
- `remote_access::tests::silent_pre_auth_close_returns_stable_http_status`
- `remote_access::tests::tunnel_keeps_partial_outer_body_when_local_traffic_wins`
- `remote_access::tests::tunnel_keeps_partial_outer_header_when_local_traffic_wins`
- `remote_access::tests::noise_pin_succeeds_and_mismatch_is_required_refusal`
- `remote_access::tests::tunnel_strips_proxy_auth_from_two_keep_alive_requests`

### bin (217)

- `control_act_tests::a_call_offer_pays_the_callees_call_price_inside_the_contact_budget`
- `control_act_tests::a_call_is_refused_before_paying_when_it_cannot_be_priced_or_authorised`
- `control_act_tests::a_file_is_uploaded_then_sent_to_one_peer`
- `control_act_tests::a_console_cancel_the_node_refused_keeps_waiting`
- `control_act_tests::a_different_message_replaces_a_record_that_holds_no_payment`
- `control_act_tests::a_cancel_the_node_refused_is_reported_and_keeps_the_request`
- `control_act_tests::a_lost_retry_reply_reconciles_by_the_same_operation`
- `control_act_tests::a_node_with_a_plaintext_seed_turns_touch_id_off_before_any_prompt`
- `control_act_tests::a_node_refusal_ends_the_budget_approval_and_releases_the_reservation`
- `control_act_tests::a_node_error_is_shown_as_the_node_wrote_it`
- `control_act_tests::a_paid_read_without_an_answer_is_accounted_and_an_unknown_one_stays_fenced`
- `control_act_tests::a_node_refusal_locks_the_window_and_the_next_send_is_refused_locally`
- `control_act_tests::a_paired_node_is_asked_and_the_owners_grant_opens_the_window`
- `control_act_tests::a_pending_console_approval_survives_an_app_restart_and_can_be_cancelled`
- `control_act_tests::a_funding_request_forwards_the_offer_and_checks_the_answer`
- `control_act_tests::a_porch_read_is_refused_before_paying_where_it_cannot_be_answered_or_authorised`
- `control_act_tests::a_pending_registration_can_be_cancelled_and_a_revoked_key_is_noticed`
- `control_act_tests::a_paired_budget_grant_opens_autopay_and_not_the_window`
- `control_act_tests::a_received_file_is_fetched_and_can_be_written_under_the_size_cap`
- `control_act_tests::a_record_without_its_key_is_not_registered_forever`
- `control_act_tests::a_received_voice_note_is_fetched_read_only_by_message_id`
- `control_act_tests::a_request_the_node_lost_in_a_restart_offers_ask_again_instead_of_waiting`
- `control_act_tests::a_refused_call_returns_without_payment_and_releases_its_reservation`
- `control_act_tests::a_restart_keeps_the_tally_and_drops_the_approval`
- `control_act_tests::a_porch_read_pays_its_quote_once_and_shows_the_verified_card`
- `control_act_tests::a_stale_status_reply_cannot_overwrite_a_newer_registration`
- `control_act_tests::a_room_leg_never_pays_above_its_confirmed_cap_even_when_the_budget_would_readmit`
- `control_act_tests::a_stranger_is_never_rung`
- `control_act_tests::a_sidecar_says_elevation_is_unavailable_and_a_lapsed_request_expires`
- `control_act_tests::a_touch_id_approval_opens_only_over_the_relation_grant_never_a_console_request`
- `control_act_tests::allin_confirmed_contact_uses_its_quote_even_below_default_fee_estimate`
- `control_act_tests::allin_legacy_missing_fee_keeps_reservation_without_false_overbudget`
- `control_act_tests::allin_fee_aware_node_reserves_only_the_confirmed_cap`
- `control_act_tests::allin_history_without_fee_keeps_full_reservation_across_restart`
- `control_act_tests::a_card_with_starter_bitcoin_reads_as_a_door_with_the_gift`
- `control_act_tests::a_voice_note_lookup_widens_the_file_window_only_as_needed`
- `control_act_tests::allin_first_contact_accepts_node_fee_quote_and_rejects_inconsistent_total`
- `control_act_tests::allin_message_receipt_includes_admission_and_aggregate_fee`
- `control_act_tests::allin_missing_response_fee_retains_the_approved_allowance`
- `control_act_tests::allin_principal_only_cap_refuses_before_payment_or_file_upload`
- `control_act_tests::allin_receipt_and_replay_charge_principal_plus_reported_fee_once`
- `control_act_tests::an_exhausted_budget_is_refused_before_any_request_and_the_cap_still_rides_along`
- `control_act_tests::an_expired_window_re_prompts_without_a_request`
- `control_act_tests::an_oversized_received_file_is_refused_before_any_write`
- `control_act_tests::an_unauthenticated_node_cannot_be_approved`
- `control_act_tests::an_expired_or_forgotten_request_also_offers_ask_again`
- `control_act_tests::budget_scope_direct_payments_count_and_refuse_before_dispatch`
- `control_act_tests::an_unknown_outcome_keeps_the_ceiling_counted_and_a_cap_refusal_releases_it`
- `control_act_tests::app_lock_and_capable_node_compose_carries_the_exact_body`
- `control_act_tests::budget_scope_failed_keysend_releases_principal`
- `control_act_tests::budget_scope_automatic_messages_and_files_share_global_total`
- `control_act_tests::budget_scope_file_rechecks_limits_after_upload_before_paid_dispatch`
- `control_act_tests::budget_scope_g1_file_reserves_admission_allowance_before_dispatch`
- `control_act_tests::budget_scope_files_share_contact_limits_and_use_budget_like_messages`
- `control_act_tests::budget_scope_invalid_payment_identity_retains_reservation`
- `control_act_tests::budget_scope_files_still_need_window_without_budget_approval`
- `control_act_tests::budget_scope_invoice_replay_reconciliation_survives_book_write_crash`
- `control_act_tests::budget_scope_invoice_replay_counts_once_across_restart`
- `control_act_tests::budget_scope_keysend_deduplicates_hash_not_identical_request_body`
- `control_act_tests::budget_scope_old_pending_payment_survives_book_write_and_reconciles`
- `control_act_tests::budget_scope_manual_actions_count_and_refuse_before_dispatch`
- `control_act_tests::budget_scope_payment_identity_survives_compaction_and_pruning`
- `control_act_tests::budget_scope_pending_payment_reconciles_exact_principal_after_restart`
- `control_act_tests::budget_scope_unknown_file_keeps_reservation_and_blocks_retry`
- `control_act_tests::caps_room_unknown_cannot_be_cleared_by_one_message_or_retried`
- `control_act_tests::caps_transmit_confirmed_ceiling_and_safe_refusal_clears_journal`
- `control_act_tests::changed_plaintext_under_a_reused_id_is_refused_and_surfaced`
- `control_act_tests::caps_unavailable_refuses_message_and_file_before_post`
- `control_act_tests::conversation_quote_matches_dispatch_cap_and_higher_price_requires_new_press`
- `control_act_tests::failed_paid_is_terminal_accounted_and_never_resent`
- `control_act_tests::first_contact_never_sends_a_paired_token_to_the_owner_grant_route`
- `control_act_tests::first_contact_quote_reads_the_stranger_quote_only_where_offered`
- `control_act_tests::front_door_publish_asks_again_when_the_node_lost_the_request`
- `control_act_tests::conversation_ceiling_failed_probe_does_not_claim_a_missing_contract`
- `control_act_tests::every_spending_action_is_refused_before_any_request_until_approved`
- `control_act_tests::conversation_ceiling_refuses_legacy_admission_outside_the_cap`
- `control_act_tests::crash_after_post_before_response_reconciles_by_operation_without_resending`
- `control_act_tests::front_door_publish_reuses_a_request_the_node_still_waits_on`
- `control_act_tests::front_door_publish_asks_the_owner_once_and_publishes_after_the_grant`
- `control_act_tests::g1_a_first_contact_the_node_will_not_back_sends_nothing`
- `control_act_tests::front_door_publish_says_plainly_when_the_node_cannot_grant_it`
- `control_act_tests::g1_a_window_never_outlives_the_node_grant`
- `control_act_tests::g1_an_unreadable_grant_opens_nothing`
- `control_act_tests::g1_a_spend_token_without_a_live_grant_asks_again`
- `control_act_tests::g1_a_budgeted_contacts_readmission_is_paid_without_a_prompt_and_counted`
- `control_act_tests::g1_a_first_contact_is_confirmed_at_the_node_for_exactly_this_contact_and_cap`
- `control_act_tests::g1_a_known_contact_the_grant_does_not_budget_asks_for_the_ok_once`
- `control_act_tests::g1_budget_exceeded_releases_the_reservation_per_reason`
- `control_act_tests::g1_a_revoked_or_expired_grant_closes_everything_before_any_payment`
- `control_act_tests::g1_the_ask_carries_a_budget_and_the_node_grant_bounds_the_approval`
- `control_act_tests::gift_owner_command_carries_exact_frozen_tuple_then_reads_funded_status`
- `control_act_tests::g1_what_the_grant_would_refuse_is_refused_before_any_payment`
- `control_act_tests::introduction_open_refuses_bad_cards_before_any_request`
- `control_act_tests::g1_known_contacts_and_older_nodes_need_no_first_contact_grant`
- `control_act_tests::introduction_open_refuses_a_dial_outside_the_cards_reach`
- `control_act_tests::introduction_open_reports_closed_mesh_and_wrong_peer`
- `control_act_tests::nodes_without_operations_and_rooms_never_get_an_operation_id`
- `control_act_tests::not_dispatched_pay_and_keysend_release_journal_and_budget`
- `control_act_tests::invites_are_created_and_redeemed_and_an_owner_only_refusal_keeps_the_window`
- `control_act_tests::introduction_open_refuses_a_weak_key_forgery_before_any_request`
- `control_act_tests::one_budget_approval_pays_messages_without_opening_the_window`
- `control_act_tests::operation_id_is_journaled_before_the_first_post_and_accepted_is_reported`
- `control_act_tests::held_cards_are_read_without_paying`
- `control_act_tests::paid_fee_survives_host_receipts_without_defaulting_missing_to_zero`
- `control_act_tests::owner_contact_cancel_pause_expiry_and_replaced_grants_never_send`
- `control_act_tests::nothing_paid_resend_reuses_the_same_operation_id`
- `control_act_tests::paid_undelivered_retry_reuses_the_operation_at_zero_cap`
- `control_act_tests::paired_gift_approval_never_posts_to_the_owner_route`
- `control_act_tests::pause_stops_every_payment_until_resumed_even_across_a_restart`
- `control_act_tests::introduction_open_sends_local_consent_only_when_given_for_a_local_card`
- `control_act_tests::introduction_open_verifies_locally_then_only_asks_the_node_to_dial`
- `control_act_tests::pay_and_keysend_502_and_other_400s_stay_unknown_spend`
- `control_act_tests::pr47_normal_reply_releases_unused_admission_allowance`
- `control_act_tests::own_introduction_must_be_signed_by_this_node`
- `control_act_tests::pr47_pause_during_granted_poll_opens_nothing`
- `control_act_tests::pr47_unknown_readmission_holds_the_node_bound_after_restart`
- `control_act_tests::pr47_accounting_recovery_requires_its_persisted_reservation`
- `control_act_tests::pay_goes_out_only_for_the_amount_shown_and_the_receipt_drops_the_preimage`
- `control_act_tests::psi_a_delivered_retry_is_recoverable_after_a_crash_before_clear`
- `control_act_tests::psi_a_retry_with_an_unknown_outcome_stays_fenced`
- `control_act_tests::psi_a_retry_needs_the_owner_approval_like_any_send`
- `control_act_tests::psi_a_budget_grant_that_could_readmit_is_never_retried_with_money`
- `control_act_tests::psi_a_second_incomplete_retry_reports_the_running_total`
- `control_act_tests::psi_aged_retry_refusal_keeps_rollback_accounting`
- `control_act_tests::psi_missing_fees_keep_the_all_in_allowance_after_restart_and_dismissal`
- `control_act_tests::psi_no_retry_unless_the_node_says_it_will_not_pay_again`
- `control_act_tests::psi_approved_fresh_admission_uses_the_node_all_in_quote_once`
- `control_act_tests::psi_identical_later_send_rejects_stale_dismissal`
- `control_act_tests::psi_reconciliation_accounts_but_never_erases_the_undelivered_record`
- `control_act_tests::psi_positive_settlement_under_zero_cap_stays_fenced`
- `control_act_tests::psi_capped_reconnect_refusal_keeps_the_same_recoverable_journal`
- `control_act_tests::psi_paired_approved_retry_renews_the_consumed_contact_authorization`
- `control_act_tests::psi_retry_accounting_survives_pruning_while_its_record_needs_it`
- `control_act_tests::psi_retry_delivery_never_buys_an_admission_when_the_fresh_price_falls`
- `control_act_tests::psi_settled_undelivered_is_paid_not_unknown_and_keeps_the_fence`
- `control_act_tests::public_receipt_cannot_replace_the_nodes_actual_approval`
- `control_act_tests::psi_retry_refused_for_capped_readmission_does_not_ask_for_approval`
- `control_act_tests::quoted_readmission_outside_the_budget_asks_once_and_keeps_the_operation`
- `control_act_tests::quoted_readmission_retry_delivery_asks_for_the_contacts_quote`
- `control_act_tests::psi_retry_delivery_pays_nothing_and_the_approved_retry_reuses_the_record`
- `control_act_tests::quoted_readmission_within_the_contact_budget_needs_a_new_press`
- `control_act_tests::rc7_and_malformed_capabilities_refuse_all_variable_sends`
- `control_act_tests::raised_conversation_price_obeys_budget_before_confirmation`
- `control_act_tests::quoted_readmission_a_refused_cap_that_already_fits_is_never_resent`
- `control_act_tests::readiness_refusal_clears_journal_and_allows_later_manual_send`
- `control_act_tests::receiving_needs_no_approval`
- `control_act_tests::readiness_refusal_preserves_paid_retry_record_and_accounting_until_manual_recovery`
- `control_act_tests::reconcile_during_an_in_flight_zero_cap_retry_waits_and_leaks_no_reservation`
- `control_act_tests::reconcile_never_saves_over_a_record_that_changed_during_the_lookup`
- `control_act_tests::regression_ambiguous_failure_blocks_second_dispatch`
- `control_act_tests::readiness_refusal_under_the_money_lock_frees_it_for_reconcile`
- `control_act_tests::regression_money_timeout_overrides_short_read_timeout`
- `control_act_tests::regression_lock_during_poll_discards_late_grant`
- `control_act_tests::regression_payment_ceiling_and_receipt_are_both_checked`
- `control_act_tests::regression_pending_payment_reconciles_by_hash_without_resend`
- `control_act_tests::reconcile_during_an_in_flight_send_waits_and_accounts_it_once`
- `control_act_tests::regression_price_rise_refused_before_money_post`
- `control_act_tests::register_once_then_a_touch_id_envelope_opens_sending_to_that_contact_only`
- `control_act_tests::regression_file_requotes_after_upload_before_spending`
- `control_act_tests::resend_after_restart_refused_for_capped_readmission_is_named_and_stays_resumable`
- `control_act_tests::regression_timeout_blocks_retry_and_survives_reopen`
- `control_act_tests::regression_receipt_above_shown_quote_is_not_success`
- `control_act_tests::restart_with_a_paid_operation_offers_the_same_id_retry_never_a_fresh_send`
- `control_act_tests::review_l4_readmission_respects_lowered_daily_limit`
- `control_act_tests::review_l4_readmission_respects_lowered_contact_limit`
- `control_act_tests::review_regression_first_contact_forwards_chosen_contact_budget`
- `control_act_tests::review_regression_pause_during_held_grant_read_blocks_payment`
- `control_act_tests::review_regression_readmission_is_counted_and_survives_restart`
- `control_act_tests::review_l4_settle_io_failure_keeps_readmission_accounted_or_blocked`
- `control_act_tests::room_fee_default_policy_control`
- `control_act_tests::room_fee_higher_node_floor_is_displayed_and_authorized`
- `control_act_tests::room_fee_config_is_a_startup_snapshot_and_invalid_policy_fails_closed`
- `control_act_tests::room_fee_restart_discards_policy_before_adopting_another_listener`
- `control_act_tests::room_fee_mixed_prices_allow_a_route_inside_the_larger_member_quote`
- `control_act_tests::room_fee_terminated_node_cannot_lend_its_policy_to_a_replacement`
- `control_act_tests::room_fee_unknown_policy_does_not_silently_use_app_defaults`
- `control_act_tests::rooms_send_only_when_every_member_is_a_connected_peer`
- `control_act_tests::room_fee_higher_policy_requires_another_approval_at_unchanged_principal`
- `control_act_tests::room_fee_member_increase_needs_approval_even_when_total_cap_fits`
- `control_act_tests::sponsor_reconcile_uses_read_authority_without_approval_or_a_spend_window`
- `control_act_tests::the_daily_total_caps_all_contacts_and_lowering_it_needs_no_approval`
- `control_act_tests::the_nodes_refusal_reason_reaches_the_owner`
- `control_act_tests::the_status_save_waits_for_the_device_lifecycle_lock`
- `control_act_tests::unresolved_payment_stays_fenced_and_is_named_payment_unknown`
- `control_act_tests::the_owner_command_names_the_nodes_config_when_the_node_does_not`
- `control_act_tests::the_node_refusing_a_read_before_paying_releases_the_budget_and_the_journal`
- `control_read_tests::a_node_error_surfaces_the_route_and_the_node_text_only`
- `control_read_tests::bad_ids_are_refused_before_any_request`
- `control_read_tests::every_read_carries_the_bearer_and_hits_only_get_routes`
- `control_read_tests::messages_come_back_oldest_first_for_the_asked_track`
- `control_read_tests::price_quote_falls_back_to_own_price_when_no_peer_table_is_cached`
- `device_key::tests::enclave_is_available`
- `device_key::tests::empty_message_signs`
- `device_key::tests::create_returns_blob_and_uncompressed_public_key`
- `device_key::tests::garbage_blob_is_invalid`
- `device_key::tests::the_public_key_reads_back_from_the_blob_without_signing`
- `device_key::tests::signature_verifies_and_tamper_fails`
- `model_launch::macos::tests::launch_scratch_is_writable`
- `model_launch::macos::tests::drop_reaps_forked_descendants_after_leader_exits`
- `model_launch::macos::tests::launch_speaks_only_over_the_broker_pipe`
- `model_launch::macos::tests::drop_reaps_descendant_after_leader_signaled`
- `model_launch::macos::tests::launch_passes_the_profile_as_an_argument`
- `pairing_wiring_tests::a_paired_401_is_never_reminted_via_auth_local`
- `pairing_wiring_tests::assistant_auth_follows_the_established_mode`
- `pairing_wiring_tests::authenticate_on_rc7_falls_back_to_auth_local`
- `pairing_wiring_tests::authenticate_pairs_and_never_calls_auth_local`
- `pairing_wiring_tests::authenticate_refusal_leaves_no_token_and_no_fallback`
- `pairing_wiring_tests::bootstrap_node_is_reported_and_not_marked_ready`
- `pairing_wiring_tests::call_api_refreshes_a_paired_token_before_it_expires`
- `pairing_wiring_tests::external_mode_reads_the_node_dir_and_writes_only_the_app_dir`
- `pairing_wiring_tests::without_external_mode_the_challenge_must_be_in_the_data_dir`
- `verified_local_socket_tests::decoy_ipv4_listener_is_not_the_supervised_ipv6_sibling`
- `verified_local_socket_tests::ipv4_owner_matches_the_process_we_connect_to`
- `model_launch::macos::tests::launch_denies_network`
- `model_launch::macos::tests::launch_child_fds_are_only_the_broker_pipes`
- `model_launch::macos::tests::launch_denies_home_keychain_and_node_data`
- `model_launch::macos::tests::launch_model_dir_is_read_only`

### integration (10)

- `unreachable_node_is_a_failure_not_a_fallback`
- `closed_pairing_409_is_a_failure_not_a_fallback`
- `rejected_proof_401_is_a_failure_not_a_fallback`
- `full_ceremony_pairs_read_receive_and_mints_a_paired_token`
- `bootstrap_node_is_detected_and_grants_identity_during_first_run`
- `paired_token_is_refreshed_before_it_expires`
- `rc7_node_without_pair_routes_falls_back_to_auth_local`
- `short_code_mismatch_trips_and_does_not_pair`
- `revoked_stored_pairing_is_a_failure_not_a_fallback`
- `challenge_path_outside_the_node_data_dir_is_refused`

### onboarding (4)

- `a_paired_live_answer_without_node_as_of_has_unknown_freshness`
- `an_rc7_node_falls_back_and_the_assistant_stays_mock`
- `after_pairing_node_as_of_uses_each_routes_own_bound`
- `first_run_pairs_then_the_first_answer_is_live_with_a_freshness_label`
