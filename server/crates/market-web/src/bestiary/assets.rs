//! `server/static/bestiary.css`, compiled into the binary. Empty since R5:
//! the pages link `web/css/base.css` plus `item.css` / `dex.css`. The route
//! stays so pages cached before the switch do not request a 404.

pub const CSS: &str = include_str!("../../../../static/bestiary.css");
