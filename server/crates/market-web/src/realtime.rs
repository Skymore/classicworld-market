//! Committed database changes -> one LISTEN connection -> shared SSE stream.
use crate::{
    api::{reader, ClientAddr},
    AppState,
};
use axum::{
    extract::State,
    http::HeaderMap,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
};
use futures_util::stream;
use sqlx::{postgres::PgListener, PgPool};
use std::{convert::Infallible, time::Duration};
use tokio::sync::broadcast;

pub async fn listen(
    db: PgPool,
    events: broadcast::Sender<()>,
    updates: tokio::sync::watch::Sender<Option<String>>,
) {
    // LISTEN holds its connection for the process lifetime, not a read slot.
    let db = sqlx::postgres::PgPoolOptions::new().max_connections(1)
        .connect_lazy_with(db.connect_options().as_ref().clone());
    loop {
        let result = async {
            let mut listener = PgListener::connect_with(&db).await?;
            listener.listen("market_changed").await?;
            listener.listen("collector_update").await?;
            let _ = events.send(());
            loop {
                match listener.try_recv().await? {
                    Some(notice) if notice.channel() == "collector_update" => {
                        if crate::collector_updates::stable_tag(notice.payload()) {
                            updates.send_if_modified(|tag| {
                                if tag.as_deref() == Some(notice.payload()) {
                                    return false;
                                }
                                *tag = Some(notice.payload().to_owned());
                                true
                            });
                        }
                    }
                    _ => {
                        let _ = events.send(());
                    }
                }
            }
            #[allow(unreachable_code)]
            Ok::<(), sqlx::Error>(())
        }
        .await;
        if let Err(error) = result {
            tracing::warn!(%error,"market event listener reconnecting");
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

pub async fn events(
    State(state): State<AppState>,
    ClientAddr(addr): ClientAddr,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = reader(&state, &headers, &addr, "events").await {
        return response;
    }
    let receiver = state.events.subscribe();
    let updates = stream::unfold((receiver, true, tokio::time::Instant::now()), |(mut receiver, first, last)| async move {
        if !first {
            match receiver.recv().await {
                Ok(()) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => return None,
            }
            // A burst is one invalidation, including its last committed change.
            // Bound refresh fan-out for existing clients as well as new ones.
            tokio::time::sleep_until(last + Duration::from_secs(1)).await;
            loop {
                match receiver.try_recv() {
                    Ok(()) | Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
                    _ => break,
                }
            }
        }
        // Public invalidation only. Personal alerts stay behind their bearer API.
        Some((
            Ok::<_, Infallible>(Event::default().event("market").data("{}")),
            (receiver, false, tokio::time::Instant::now()),
        ))
    });
    let mut response = Sse::new(updates)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response();
    response
        .headers_mut()
        .insert("x-accel-buffering", "no".parse().unwrap());
    response
}
