//! Bounded micro-batches for the existing single-observation HTTP protocol.
use std::time::{Duration, Instant};

use axum::body::Bytes;
use market_core::protocol::Upload;
use sqlx::PgPool;
use tokio::sync::{mpsc, oneshot, OnceCell};

use crate::{auth::Collector, ingest::{ingest_batch, IngestError, IngestOutcome, Received}};

const MAX_BATCH: usize = 16;
const MAX_ROWS: usize = 256;
const COLLECT_FOR: Duration = Duration::from_millis(20);

struct Job {
    collector: Collector,
    upload: Upload,
    raw: Bytes,
    received_at: f64,
    response: oneshot::Sender<Result<IngestOutcome, IngestError>>,
}

pub enum QueueError {
    Full,
    Ingest(IngestError),
}

pub struct UploadQueue {
    db: PgPool,
    sender: OnceCell<mpsc::Sender<Job>>,
}

impl UploadQueue {
    pub fn new(db: PgPool) -> Self { Self { db, sender: OnceCell::new() } }

    pub async fn submit(&self, collector: Collector, upload: Upload, raw: Bytes, received_at: f64)
        -> Result<IngestOutcome, QueueError>
    {
        let sender = self.sender.get_or_init(|| async {
            let (sender, receiver) = mpsc::channel(128);
            tokio::spawn(run(self.db.clone(), receiver));
            sender
        }).await;
        let (response, result) = oneshot::channel();
        sender.try_send(Job { collector, upload, raw, received_at, response })
            .map_err(|_| QueueError::Full)?;
        result.await.map_err(|_| QueueError::Ingest(sqlx::Error::WorkerCrashed.into()))?
            .map_err(QueueError::Ingest)
    }
}

async fn run(db: PgPool, mut receiver: mpsc::Receiver<Job>) {
    while let Some(first) = receiver.recv().await {
        let deadline = tokio::time::Instant::now() + COLLECT_FOR;
        let mut rows = first.upload.items.len();
        let mut batch = vec![first];
        while batch.len() < MAX_BATCH && rows < MAX_ROWS {
            match tokio::time::timeout_at(deadline, receiver.recv()).await {
                Ok(Some(job)) => { rows += job.upload.items.len(); batch.push(job); }
                _ => break,
            }
        }
        let started = Instant::now();
        let inputs: Vec<_> = batch.iter().map(|job| Received {
            collector: &job.collector, upload: &job.upload, raw: &job.raw,
            received_at: job.received_at, now: job.received_at,
        }).collect();
        let result = ingest_batch(&db, &inputs).await;
        tracing::info!(uploads = batch.len(), rows, elapsed_ms = started.elapsed().as_secs_f64() * 1000.0,
            committed = result.is_ok(), "upload batch processed");
        match result {
            Ok(outcomes) => {
                for (job, outcome) in batch.into_iter().zip(outcomes) {
                    // Disconnection never drops an upload already accepted by the queue.
                    let _ = job.response.send(outcome);
                }
            }
            Err(error) => {
                tracing::error!(%error, "upload batch rolled back");
                for job in batch {
                    let _ = job.response.send(Err(sqlx::Error::Protocol(error.to_string()).into()));
                }
            }
        }
    }
}
