//! Shortest routes over `map_portals`. Edges are directed: a return link goes
//! from a field to its town, not back. Every step costs one hop except a
//! return scroll, which costs `RETURN_COST`: walking a few portals beats
//! spending a scroll. Among routes of equal cost the one with fewer
//! non-walking steps wins, so a scroll replaces a walk of four portals or more.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet, VecDeque};

/// 射手村 (Henesys): default start for routes and the reachability check.
pub const HENESYS: i32 = 10001000;

/// Hops a return-scroll step counts as.
pub const RETURN_COST: u32 = 3;

/// Travel by NPC that no portal records: (from map, to map, kind, NPC to talk
/// to). Southperry's Shanks sails one way to Lith Harbor, the only way off
/// Maple Island. The Regular Cab (Phil in Lith Harbor) drives between the five
/// Victoria Island towns NiaDB's pathfinder lists; it costs mesos, so routes
/// use it only when asked (`taxi=1`).
pub const TRANSPORT: &[(i32, i32, EdgeKind, i32)] = &{
    const TOWNS: [(i32, i32); 5] = [
        (10_000_000, 101), // Lith Harbor, Phil
        (10_001_000, 200), // Henesys
        (10_002_000, 301), // Ellinia
        (10_003_000, 400), // Kerning City
        (10_004_000, 500), // Perion
    ];
    let mut out = [(60, 10_000_000, EdgeKind::Ship, 15); 1 + 5 * 4];
    let mut n = 1;
    let mut i = 0;
    while i < TOWNS.len() {
        let mut j = 0;
        while j < TOWNS.len() {
            if i != j {
                out[n] = (TOWNS[i].0, TOWNS[j].0, EdgeKind::Taxi, TOWNS[i].1);
                n += 1;
            }
            j += 1;
        }
        i += 1;
    }
    out
};

/// The NPC to talk to for a ship or taxi step from `from`.
pub fn transport_npc(from: i32, to: i32, kind: EdgeKind) -> Option<i32> {
    TRANSPORT
        .iter()
        .find(|t| (t.0, t.1, t.2) == (from, to, kind))
        .map(|t| t.3)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    // Order is the tie-break preference.
    Portal,
    Ship,
    Taxi,
    Return,
}

impl EdgeKind {
    pub fn parse(kind: &str) -> Option<Self> {
        match kind {
            "portal" => Some(Self::Portal),
            "ship" => Some(Self::Ship),
            "taxi" => Some(Self::Taxi),
            "return" => Some(Self::Return),
            _ => None,
        }
    }

    /// How the player takes this step.
    pub fn label_zh(self) -> &'static str {
        match self {
            Self::Portal => "走传送口",
            Self::Ship => "坐船",
            Self::Taxi => "坐出租车",
            Self::Return => "用回城卷轴（阵亡后也回到这里）",
        }
    }

    /// (hops, non-walking steps): compared in that order.
    fn cost(self) -> Cost {
        match self {
            Self::Portal => (1, 0),
            Self::Ship | Self::Taxi => (1, 1),
            Self::Return => (RETURN_COST, 1),
        }
    }
}

type Cost = (u32, u32);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edge {
    pub from: i32,
    pub to: i32,
    pub kind: EdgeKind,
    pub portal_name: Option<String>,
}

#[derive(Debug, Default)]
pub struct Graph {
    out: HashMap<i32, Vec<Edge>>,
    into: HashMap<i32, Vec<i32>>,
    edges: usize,
}

impl Graph {
    pub fn new(edges: impl IntoIterator<Item = Edge>) -> Self {
        let mut graph = Graph::default();
        for edge in edges {
            graph.into.entry(edge.to).or_default().push(edge.from);
            graph.out.entry(edge.from).or_default().push(edge);
            graph.edges += 1;
        }
        // Deterministic BFS order: preferred kind first, then target id.
        for list in graph.out.values_mut() {
            list.sort_by_key(|e| (e.kind, e.to));
        }
        graph
    }

    pub fn edge_count(&self) -> usize {
        self.edges
    }

    /// Cheapest steps from `from` to `to`; `Some(vec![])` when they are the
    /// same map, `None` when no known route exists.
    pub fn shortest_path(&self, from: i32, to: i32) -> Option<Vec<&Edge>> {
        if from == to {
            return Some(Vec::new());
        }
        // Dijkstra. Heap entries tie-break on map id, and edges are sorted,
        // so the same graph always gives the same route.
        let mut best: HashMap<i32, Cost> = HashMap::from([(from, (0, 0))]);
        let mut came_by: HashMap<i32, &Edge> = HashMap::new();
        let mut done = HashSet::new();
        let mut heap = BinaryHeap::from([Reverse(((0, 0), from))]);
        while let Some(Reverse((cost, at))) = heap.pop() {
            if at == to {
                return Some(Self::unwind(&came_by, from, to));
            }
            if !done.insert(at) {
                continue;
            }
            for edge in self.out.get(&at).into_iter().flatten() {
                let (hops, other) = edge.kind.cost();
                let next = (cost.0 + hops, cost.1 + other);
                if best.get(&edge.to).is_none_or(|&known| next < known) {
                    best.insert(edge.to, next);
                    came_by.insert(edge.to, edge);
                    heap.push(Reverse((next, edge.to)));
                }
            }
        }
        None
    }

    /// Cheapest routes from `from` to every map it reaches, for picking the
    /// nearest of several targets.
    pub fn paths_from(&self, from: i32) -> Paths<'_> {
        let mut best: HashMap<i32, Cost> = HashMap::from([(from, (0, 0))]);
        let mut came_by: HashMap<i32, &Edge> = HashMap::new();
        let mut done = HashSet::new();
        let mut heap = BinaryHeap::from([Reverse(((0, 0), from))]);
        while let Some(Reverse((cost, at))) = heap.pop() {
            if !done.insert(at) {
                continue;
            }
            for edge in self.out.get(&at).into_iter().flatten() {
                let (hops, other) = edge.kind.cost();
                let next = (cost.0 + hops, cost.1 + other);
                if best.get(&edge.to).is_none_or(|&known| next < known) {
                    best.insert(edge.to, next);
                    came_by.insert(edge.to, edge);
                    heap.push(Reverse((next, edge.to)));
                }
            }
        }
        Paths {
            from,
            best,
            came_by,
        }
    }

    fn unwind<'a>(came_by: &HashMap<i32, &'a Edge>, from: i32, to: i32) -> Vec<&'a Edge> {
        let mut steps = Vec::new();
        let mut at = to;
        while at != from {
            let edge = came_by[&at];
            steps.push(edge);
            at = edge.from;
        }
        steps.reverse();
        steps
    }

    /// Maps reachable from `start`, including `start`.
    pub fn reachable_from(&self, start: i32) -> HashSet<i32> {
        self.flood(start, |at| {
            self.out
                .get(&at)
                .into_iter()
                .flatten()
                .map(|e| e.to)
                .collect()
        })
    }

    /// Maps from which `target` is reachable, including `target`.
    pub fn reaching(&self, target: i32) -> HashSet<i32> {
        self.flood(target, |at| self.into.get(&at).cloned().unwrap_or_default())
    }

    /// Reachable when every edge is taken both ways: which maps hang
    /// together at all, regardless of direction.
    pub fn connected_to(&self, start: i32) -> HashSet<i32> {
        self.flood(start, |at| {
            let mut next: Vec<i32> = self
                .out
                .get(&at)
                .into_iter()
                .flatten()
                .map(|e| e.to)
                .collect();
            next.extend(self.into.get(&at).into_iter().flatten().copied());
            next
        })
    }

    fn flood(&self, start: i32, next: impl Fn(i32) -> Vec<i32>) -> HashSet<i32> {
        let mut seen = HashSet::from([start]);
        let mut queue = VecDeque::from([start]);
        while let Some(at) = queue.pop_front() {
            for to in next(at) {
                if seen.insert(to) {
                    queue.push_back(to);
                }
            }
        }
        seen
    }
}

/// Every cheapest route from one map (`Graph::paths_from`).
pub struct Paths<'a> {
    from: i32,
    best: HashMap<i32, Cost>,
    came_by: HashMap<i32, &'a Edge>,
}

impl<'a> Paths<'a> {
    /// The steps to `to`, `None` when it is not reached.
    pub fn to(&self, to: i32) -> Option<Vec<&'a Edge>> {
        self.best
            .contains_key(&to)
            .then(|| Graph::unwind(&self.came_by, self.from, to))
    }

    /// Of `targets`, the one reached most cheaply (ties: lower map id).
    pub fn nearest(&self, targets: impl IntoIterator<Item = i32>) -> Option<i32> {
        targets
            .into_iter()
            .filter_map(|t| self.best.get(&t).map(|&cost| (cost, t)))
            .min()
            .map(|(_, t)| t)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(from: i32, to: i32, kind: EdgeKind) -> Edge {
        Edge {
            from,
            to,
            kind,
            portal_name: None,
        }
    }

    /// 1 -> 2 -> 3 -> 4 by portals, 1 -> 5 by ship, 5 -> 4 by portal,
    /// 6 -> 1 return link; 7 isolated.
    fn graph() -> Graph {
        use EdgeKind::*;
        Graph::new([
            edge(1, 2, Portal),
            edge(2, 3, Portal),
            edge(3, 4, Portal),
            edge(1, 5, Ship),
            edge(5, 4, Portal),
            edge(6, 1, Return),
            edge(2, 1, Portal),
        ])
    }

    fn hops(path: &[&Edge]) -> Vec<(i32, i32)> {
        path.iter().map(|e| (e.from, e.to)).collect()
    }

    #[test]
    fn finds_fewest_steps() {
        let g = graph();
        assert_eq!(hops(&g.shortest_path(1, 4).unwrap()), vec![(1, 5), (5, 4)]);
        assert_eq!(
            hops(&g.shortest_path(6, 3).unwrap()),
            vec![(6, 1), (1, 2), (2, 3)]
        );
    }

    #[test]
    fn prefers_portals_on_ties() {
        use EdgeKind::*;
        let g = Graph::new([
            edge(1, 2, Ship),
            edge(2, 3, Portal),
            edge(1, 4, Portal),
            edge(4, 3, Portal),
        ]);
        assert_eq!(hops(&g.shortest_path(1, 3).unwrap()), vec![(1, 4), (4, 3)]);
    }

    /// A field one to five portals from town, plus its return link.
    fn walk_or_scroll(portals: i32) -> Graph {
        use EdgeKind::*;
        let mut edges: Vec<Edge> = (0..portals)
            .map(|i| edge(100 + i, 101 + i, Portal))
            .collect();
        edges.push(edge(100, 100 + portals, Return));
        Graph::new(edges)
    }

    #[test]
    fn walking_beats_a_scroll_up_to_three_portals() {
        for portals in 1..=3 {
            let g = walk_or_scroll(portals);
            let path = g.shortest_path(100, 100 + portals).unwrap();
            assert_eq!(path.len(), portals as usize, "{portals} portals");
            assert!(path.iter().all(|e| e.kind == EdgeKind::Portal));
        }
        for portals in 4..=5 {
            let g = walk_or_scroll(portals);
            let path = g.shortest_path(100, 100 + portals).unwrap();
            assert_eq!(hops(&path), vec![(100, 100 + portals)], "{portals} portals");
            assert_eq!(path[0].kind, EdgeKind::Return);
        }
    }

    #[test]
    fn scroll_then_walk_when_it_is_cheaper() {
        use EdgeKind::*;
        // 1 -> 2 -> ... -> 7 by portals (6 hops) or scroll to 6 then one portal (4 hops).
        let mut edges: Vec<Edge> = (1..7).map(|i| edge(i, i + 1, Portal)).collect();
        edges.push(edge(1, 6, Return));
        let g = Graph::new(edges);
        assert_eq!(hops(&g.shortest_path(1, 7).unwrap()), vec![(1, 6), (6, 7)]);
    }

    #[test]
    fn edges_are_directed() {
        let g = graph();
        assert!(
            g.shortest_path(1, 6).is_none(),
            "return link has no way back"
        );
        assert!(g.shortest_path(4, 1).is_none());
        assert!(g.shortest_path(1, 7).is_none(), "unknown map");
        assert_eq!(g.shortest_path(7, 7), Some(vec![]));
    }

    #[test]
    fn transport_has_the_ship_and_every_taxi_pair() {
        assert_eq!(TRANSPORT.len(), 21);
        assert_eq!(transport_npc(60, 10_000_000, EdgeKind::Ship), Some(15));
        assert_eq!(
            transport_npc(10_000_000, 60, EdgeKind::Ship),
            None,
            "one way"
        );
        assert_eq!(
            transport_npc(10_001_000, 10_004_000, EdgeKind::Taxi),
            Some(200)
        );
        assert_eq!(
            transport_npc(10_000_000, 10_002_000, EdgeKind::Taxi),
            Some(101)
        );
        assert!(TRANSPORT.iter().all(|t| t.0 != t.1));
    }

    #[test]
    fn nearest_target_and_its_route() {
        let g = graph();
        let paths = g.paths_from(1);
        assert_eq!(
            paths.nearest([3, 4, 7]),
            Some(3),
            "1-2-3 walks; 1-5-4 needs the ship"
        );
        assert_eq!(paths.nearest([4, 5]), Some(5));
        assert_eq!(paths.nearest([6, 7]), None, "unreachable");
        assert_eq!(hops(&paths.to(3).unwrap()), vec![(1, 2), (2, 3)]);
        assert_eq!(paths.to(1), Some(vec![]));
        assert_eq!(paths.to(6), None);
    }

    #[test]
    fn reachability() {
        let g = graph();
        assert_eq!(g.reachable_from(1), HashSet::from([1, 2, 3, 4, 5]));
        assert_eq!(g.reaching(1), HashSet::from([1, 2, 6]));
        assert_eq!(g.connected_to(4), HashSet::from([1, 2, 3, 4, 5, 6]));
        assert_eq!(g.reachable_from(7), HashSet::from([7]));
        assert_eq!(g.edge_count(), 7);
    }
}
