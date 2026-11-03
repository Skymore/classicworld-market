//! Bestiary: items, mobs, maps, NPCs and routes (REDESIGN_PLAN_V2 §3.2, §4).
//!
//! Data flow: `catalog` (items.sqlite) and `mapledex` (JSON) parse into
//! `rows`; `import` writes them; `wz` adds Map.wz portals. Pages: `queries`
//! reads `model` structs, `pages` renders them, `http` serves them.

pub mod assets;
pub mod catalog;
pub mod cli;
mod dex_api;
pub mod equipment;
pub mod format;
pub mod http;
pub mod import;
pub mod mapledex;
pub mod model;
pub mod pages;
pub mod queries;
pub mod quests;
pub mod regions;
pub mod route;
pub mod rows;
pub mod wz;

pub use http::routes;
