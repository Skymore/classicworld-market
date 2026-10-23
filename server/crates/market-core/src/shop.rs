//! Shop identity.
//!
//! The shared site used to key a shop by (world, location, shop id, title,
//! UTC day). A sold-out row seen again after midnight was then counted as a
//! second sale and yesterday's snapshot stayed in the live listings as a
//! second shop. The key here has no date. When the collector could not read
//! the location, the collector id is added so two players' shops with the
//! same name do not merge.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::protocol::MARKET_MAP_BASE;
use crate::pyjson;

/// Free-market position of a shop: channel and room ("hole").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Location {
    pub channel: u16,
    pub room: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ShopIdentity {
    pub world: String,
    pub location: Option<Location>,
    pub shop_id: u32,
    pub title: String,
    /// Collector that observed the shop. Only part of the key when the
    /// location is unknown.
    pub collector: String,
}

impl ShopIdentity {
    /// Stable key for the `shops` table. Plain text rather than a hash so it
    /// can be read in the database.
    pub fn key(&self) -> String {
        match self.location {
            Some(Location { channel, room }) => format!(
                "{}|ch{}|r{}|{}|{}",
                self.world,
                channel,
                room,
                self.shop_id,
                escape(&self.title)
            ),
            None => format!(
                "{}|?|{}|{}|{}",
                self.world,
                self.shop_id,
                escape(&self.title),
                escape(&self.collector)
            ),
        }
    }

    /// Python's `listing_shop` digest. Served as `shop_key`: it groups rows
    /// by shop without revealing the collector id inside `key()`, and matches
    /// the ids the Python site served.
    pub fn public_key(&self) -> String {
        let location = self.location.map_or(Value::Null, |l| {
            json!({"channel": l.channel, "room": l.room, "map_id": MARKET_MAP_BASE + u32::from(l.room)})
        });
        let collector = if self.location.is_some() {
            Value::Null
        } else {
            json!(self.collector)
        };
        let identity = json!([
            "shared-listing-v1",
            self.world,
            location,
            self.shop_id,
            self.title,
            collector
        ]);
        pyjson::sha256_hex(pyjson::dumps(&identity, pyjson::Dumps::UNICODE).as_bytes())
    }
}

/// Python's visit id, `digest([collector, observation_id])`. Orders same-time
/// observations and seeds sale ids.
pub fn visit_key(collector: &str, observation_id: &str) -> String {
    pyjson::digest(&json!([collector, observation_id]))
}

fn escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('|', "\\|")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shop(location: Option<Location>, collector: &str) -> ShopIdentity {
        ShopIdentity {
            world: "Scania".into(),
            location,
            shop_id: 42,
            title: "ores|cheap".into(),
            collector: collector.into(),
        }
    }

    #[test]
    fn located_shops_ignore_collector() {
        let a = shop(
            Some(Location {
                channel: 3,
                room: 7,
            }),
            "alice",
        );
        let b = shop(
            Some(Location {
                channel: 3,
                room: 7,
            }),
            "bob",
        );
        assert_eq!(a.key(), b.key());
        assert_eq!(a.key(), r"Scania|ch3|r7|42|ores\|cheap");
    }

    #[test]
    fn unlocated_shops_are_separated_by_collector() {
        let a = shop(None, "alice");
        let b = shop(None, "bob");
        assert_ne!(a.key(), b.key());
    }

    #[test]
    fn located_and_unlocated_never_collide() {
        let a = shop(
            Some(Location {
                channel: 1,
                room: 1,
            }),
            "alice",
        );
        let b = shop(None, "alice");
        assert_ne!(a.key(), b.key());
    }

    #[test]
    fn public_key_matches_python_listing_shop() {
        // market_dashboard.listing_shop for the same identities.
        let located = ShopIdentity {
            world: "ClassicWorld".into(),
            location: Some(Location {
                channel: 1,
                room: 7,
            }),
            shop_id: 20219,
            title: "g".into(),
            collector: "fixture".into(),
        };
        assert_eq!(
            located.public_key(),
            "215144cf752c1913fec8b2d6a7970b6820abc4d7d90e77e37f224d7fb7300f94"
        );
        let unlocated = ShopIdentity {
            world: "ClassicWorld".into(),
            location: None,
            shop_id: 1,
            title: "雪|\"x".into(),
            collector: "m".into(),
        };
        assert_eq!(
            unlocated.public_key(),
            "5e22ca9484eb5a4120495d77966f7d75caa1936d327a3db9d7348bdf5f0b0b99"
        );
    }

    #[test]
    fn visit_key_matches_python_digest() {
        assert_eq!(
            visit_key("fixture", "oid"),
            "cf6091435839990cff5daa8d9039e1a37ebd539c908e1655323550cc20e36622"
        );
    }
}
