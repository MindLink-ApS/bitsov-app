//! Dispatcher over the closed Phase 1 read tools.
//!
//! The only node operation is [`NodeRead::read`] with a [`ReadRoute`]. Tool
//! calls that are not one of the six read tools never reach it. The model
//! may be shown only [`Dispatch::output`]; the host log stays in this module.

mod freshness;
mod local_read;
mod route;
mod schema;
mod snapshot;
mod tools;

pub use local_read::{
    admit, AuditSink, BaseUrlRejected, BearerToken, DenyReason, LocalNodeRead, StderrAudit,
};
pub use snapshot::Snapshot;

#[allow(unused_imports)]
pub use freshness::{
    node_time_field, parse_as_of, route_key, stale_after, Fetched, FreshnessState, NodeMarks,
    NodeTimeField, RouteFreshness, MAX_NODE_SKEW, STALE_AFTER, WALLET_STALE_AFTER,
    WALLET_SYNC_INTERVAL,
};

#[allow(unused_imports)]
pub use route::{PeerKey, ReadRoute, RequestTarget, ALLOWED_PATHS};
#[allow(unused_imports)]
pub use schema::{
    Amount, BalanceInput, BalanceReport, CategoryFeeTarget, CategoryPrice, ChainBackend,
    ChannelPeer, ChannelSummary, ChannelsInput, ChannelsReport, CopiedId, HealthInput, HealthReport,
    Direction, LightningBackend, Liveness, LocalPrices, LocalPricesInput, MessageCountsInput,
    MessageMetadata, PaymentEntry, PaymentsInput, PaymentsReport, PriceCategory, PricingMode,
    Report, SenderCount, SourceField, TargetFee, ToolCall, ToolOutput, TrustLevel,
    UnavailableReason, Unit, WalletBalanceLabel, MAX_MESSAGE_LIMIT, MAX_PAYMENT_ENTRIES,
    MAX_PAYMENT_PEERS, PAYMENT_THREAD_LIMIT,
};

use std::fmt;

use schema::default_message_limit;

/// Node body as read by the broker. `Debug` redacts the bytes.
#[derive(Clone)]
pub struct RawRead {
    status: u16,
    body: Vec<u8>,
    /// Host stamp from a real read. `None` for the in-process mock.
    fetched: Option<Fetched>,
    /// Node freshness headers on a 2xx. Default (none) for rc7, errors and
    /// the in-process mock.
    marks: NodeMarks,
}

impl RawRead {
    pub fn new(status: u16, body: Vec<u8>) -> Self {
        Self {
            status,
            body,
            fetched: None,
            marks: NodeMarks::default(),
        }
    }

    /// The same read, carrying what the node's headers said.
    pub fn marked(self, marks: NodeMarks) -> Self {
        Self { marks, ..self }
    }

    /// The same read, stamped with when the host finished reading it.
    pub fn stamped(self, fetched: Fetched) -> Self {
        Self {
            fetched: Some(fetched),
            ..self
        }
    }
}

impl fmt::Debug for RawRead {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RawRead")
            .field("status", &self.status)
            .field("body_len", &self.body.len())
            .field("fetched", &self.fetched.is_some())
            .finish()
    }
}

/// A read failed before a usable body existed. Neither variant carries a string or a body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadFault {
    /// Transport failed before a response existed.
    Transport,
    /// The node marked the body stale. The body is not attached.
    Stale,
}

/// What the trusted side may call. Implementors must not log `RawRead`'s body.
pub trait NodeRead {
    fn read(&self, route: ReadRoute) -> Result<RawRead, ReadFault>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogOutcome {
    Ready,
    Transport,
    /// HTTP status for the host log. Tool output does not carry this number.
    Http {
        status: u16,
    },
    Decode,
    /// The node marked the body stale. The body was not decoded.
    Stale,
}

/// Host log of a read. Paths come from the allowlist, never from a response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadLog {
    pub method: &'static str,
    pub path: &'static str,
    pub query: Option<route::Query>,
    pub outcome: LogOutcome,
}

/// One read-tool execution.
///
/// Only [`Dispatch::output`] may be serialized and forwarded to the model.
/// `log` is a host record of allowlisted paths and outcomes. It is private
/// and does not implement `Serialize`.
#[derive(Debug, Clone, PartialEq)]
pub struct Dispatch {
    output: ToolOutput,
    log: Vec<ReadLog>,
}

impl Dispatch {
    /// The only value that may reach the model.
    pub fn output(&self) -> &ToolOutput {
        &self.output
    }
}

/// The route table failed its construction-time check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AllowlistError;

impl fmt::Display for AllowlistError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("read route allowlist rejected a route")
    }
}

/// The tool call was not one of the six read tools, or its input was invalid.
/// The node is not contacted. The value does not echo the request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rejected;

impl fmt::Display for Rejected {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("rejected")
    }
}

#[derive(Debug)]
pub struct Broker;

impl Broker {
    pub fn new() -> Result<Self, AllowlistError> {
        route::enforce().map_err(|_| AllowlistError)?;
        Ok(Self)
    }

    pub fn execute(&self, node: &impl NodeRead, bytes: &[u8]) -> Result<Dispatch, Rejected> {
        self.dispatch(node, parse_call(bytes)?)
    }

    pub fn dispatch(&self, node: &impl NodeRead, call: ToolCall) -> Result<Dispatch, Rejected> {
        let mut log = Vec::new();
        let output = match call {
            ToolCall::Balance { input: _ } => ToolOutput::Balance {
                report: tools::balance(node, &mut log),
            },
            ToolCall::Channels { input: _ } => ToolOutput::Channels {
                report: tools::channels(node, &mut log),
            },
            ToolCall::Health { input: _ } => ToolOutput::Health {
                report: tools::health(node, &mut log),
            },
            ToolCall::MessageCounts { input } => {
                if input.limit == 0 || input.limit > MAX_MESSAGE_LIMIT {
                    return Err(Rejected);
                }
                ToolOutput::MessageCounts {
                    report: tools::messages(node, input.limit, &mut log),
                }
            }
            ToolCall::LocalPrices { input: _ } => ToolOutput::LocalPrices {
                report: tools::prices(node, &mut log),
            },
            ToolCall::Payments { input } => ToolOutput::Payments {
                report: tools::payments(node, input.since_ms, &mut log),
            },
        };
        Ok(Dispatch { output, log })
    }
}

pub fn parse_call(bytes: &[u8]) -> Result<ToolCall, Rejected> {
    // Drop the serde error so a rejected tool name or stray field is not echoed.
    serde_json::from_slice(bytes).map_err(|_| Rejected)
}

pub fn default_limit() -> u32 {
    default_message_limit()
}

#[cfg(test)]
mod mock_read;
#[cfg(test)]
pub(crate) mod test_server;
#[cfg(test)]
mod payments_tests;
#[cfg(test)]
mod tests;
