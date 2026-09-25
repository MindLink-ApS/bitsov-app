//! Dispatcher over the closed Phase 1 read tools.
//!
//! The only node operation is [`NodeRead::read`] with a [`ReadRoute`]. Tool
//! calls that are not one of the five read tools never reach it.

mod route;
mod schema;
mod tools;

#[allow(unused_imports)]
pub use route::{ReadRoute, RequestTarget, ALLOWED_PATHS};
#[allow(unused_imports)]
pub use schema::{
    Amount, BalanceInput, BalanceReport, CategoryFeeTarget, CategoryPrice, ChainBackend,
    ChannelSummary, ChannelsInput, ChannelsReport, CopiedId, HealthInput, HealthReport,
    LightningBackend, Liveness, LocalPrices, LocalPricesInput, MessageCountsInput, MessageMetadata,
    PriceCategory, PricingMode, Report, SenderCount, SourceField, TargetFee, ToolCall, ToolOutput,
    TrustLevel, UnavailableReason, Unit, WalletBalanceLabel, MAX_MESSAGE_LIMIT,
};

use std::fmt;

use schema::default_message_limit;

/// Node body as read by the broker. `Debug` redacts the bytes.
pub struct RawRead {
    status: u16,
    body: Vec<u8>,
}

impl RawRead {
    pub fn new(status: u16, body: Vec<u8>) -> Self {
        Self { status, body }
    }
}

impl fmt::Debug for RawRead {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RawRead")
            .field("status", &self.status)
            .field("body_len", &self.body.len())
            .finish()
    }
}

/// Transport failed before a response existed. Carries no error string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransportFault;

/// What the trusted side may call. Implementors must not log `RawRead`'s body.
pub trait NodeRead {
    fn read(&self, route: ReadRoute) -> Result<RawRead, TransportFault>;
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
}

/// Host log of a read. Paths come from the allowlist, never from a response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadLog {
    pub method: &'static str,
    pub path: &'static str,
    pub query: Option<route::Query>,
    pub outcome: LogOutcome,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Dispatch {
    pub output: ToolOutput,
    pub log: Vec<ReadLog>,
}

/// The route table failed its construction-time check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AllowlistError;

impl fmt::Display for AllowlistError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("read route allowlist rejected a route")
    }
}

/// The tool call was not one of the five read tools, or its input was invalid.
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
mod tests;
