//! Slow writer phases only; never log collector identities or input content.
use std::time::Instant;

#[derive(Clone, Copy)]
pub(crate) enum Phase {
    Prepare,
    Pool,
    Lock,
    Write,
    Stats,
    Commit,
}

pub(crate) struct WriteTiming {
    kind: &'static str,
    started: Instant,
    checkpoint: Instant,
    phases: [f64; 6],
    outcome: &'static str,
    pub units: usize,
    pub items: usize,
}

impl WriteTiming {
    pub fn new(kind: &'static str) -> Self {
        let now = Instant::now();
        Self {
            kind,
            started: now,
            checkpoint: now,
            phases: [0.; 6],
            outcome: "unfinished",
            units: 1,
            items: 0,
        }
    }

    pub fn mark(&mut self, phase: Phase) {
        let now = Instant::now();
        self.phases[phase as usize] += (now - self.checkpoint).as_secs_f64() * 1000.;
        self.checkpoint = now;
    }

    pub fn committed(&mut self) {
        self.mark(Phase::Commit);
        self.outcome = "committed";
    }
    pub fn duplicate(&mut self) {
        self.mark(Phase::Write);
        self.outcome = "duplicate";
    }
}

impl Drop for WriteTiming {
    fn drop(&mut self) {
        let elapsed_ms = self.started.elapsed().as_secs_f64() * 1000.;
        if elapsed_ms >= 100. {
            tracing::info!(
                kind = self.kind,
                outcome = self.outcome,
                units = self.units,
                items = self.items,
                elapsed_ms,
                prepare_ms = self.phases[0],
                pool_ms = self.phases[1],
                lock_ms = self.phases[2],
                write_ms = self.phases[3],
                stats_ms = self.phases[4],
                commit_ms = self.phases[5],
                unfinished_ms = self.checkpoint.elapsed().as_secs_f64() * 1000.,
                "slow writer phases"
            );
        }
    }
}
