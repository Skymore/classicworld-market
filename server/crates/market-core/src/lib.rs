//! Pure domain logic shared by the web service and the browser reader.
//!
//! Nothing in this crate does IO. `market-web` feeds it rows from Postgres
//! and the WASM build feeds it frames from the screen share.

pub mod item;
pub mod opportunities;
pub mod pricing;
pub mod protocol;
pub mod pyjson;
pub mod reader;
pub mod report;
pub mod sales;
pub mod shop;
pub mod stats;

pub use shop::{visit_key, Location, ShopIdentity};
