//! One read per route for a batch of tool calls.
//!
//! The assistant feed answers 50 questions from five routes. This wrapper
//! reads each route once, so the rows are one consistent snapshot and a hung
//! node costs one timeout per route, not one per question.

use std::cell::RefCell;

use super::freshness::{route_key, RouteFreshness};
use super::route::ReadRoute;
use super::{NodeRead, RawRead, ReadFault};

pub struct Snapshot<'a, R: NodeRead> {
    inner: &'a R,
    reads: RefCell<Vec<(ReadRoute, Result<RawRead, ReadFault>)>>,
}

impl<'a, R: NodeRead> Snapshot<'a, R> {
    pub fn new(inner: &'a R) -> Self {
        Self {
            inner,
            reads: RefCell::new(Vec::new()),
        }
    }

    /// A read failed before any response existed.
    pub fn transport_failed(&self) -> bool {
        self.reads
            .borrow()
            .iter()
            .any(|(_, read)| matches!(read, Err(ReadFault::Transport)))
    }

    /// Freshness of each route that returned a response, by route name.
    /// A read that failed in transport has none.
    pub fn freshness(&self) -> Vec<RouteFreshness> {
        let mut out: Vec<RouteFreshness> = self
            .reads
            .borrow()
            .iter()
            .filter_map(|(route, read)| {
                read.as_ref()
                    .ok()
                    .map(|raw| RouteFreshness::assess(*route, raw))
            })
            .collect();
        out.sort_by_key(|fresh| route_key(fresh.route));
        out
    }

    /// Every route read so far, in order.
    pub fn routes(&self) -> Vec<ReadRoute> {
        self.reads
            .borrow()
            .iter()
            .map(|(route, _)| *route)
            .collect()
    }

    /// The node refused the token on some read.
    pub fn unauthorized(&self) -> bool {
        self.reads
            .borrow()
            .iter()
            .any(|(_, read)| matches!(read, Ok(raw) if raw.status == 401))
    }
}

impl<R: NodeRead> NodeRead for Snapshot<'_, R> {
    fn read(&self, route: ReadRoute) -> Result<RawRead, ReadFault> {
        if let Some((_, read)) = self.reads.borrow().iter().find(|(seen, _)| *seen == route) {
            return read.clone();
        }
        let read = self.inner.read(route);
        self.reads.borrow_mut().push((route, read.clone()));
        read
    }
}
