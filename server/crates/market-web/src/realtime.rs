//! Committed database changes -> one LISTEN connection -> shared SSE stream.
use crate::{
    api::{reader, ClientAddr},
    AppState,
};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
};
use futures_util::stream;
use sqlx::{postgres::PgListener, PgPool};
use std::{convert::Infallible, time::Duration};
use tokio::sync::broadcast;

/// Account event topics; each names the endpoint a client refetches.
const TOPICS: [&str; 3] = ["data", "sweep", "devices"];
/// Broadcast account id meaning "every account": notices may have been missed.
const EVERY_ACCOUNT: i64 = 0;

/// Queues an account event; Postgres delivers it only if the transaction commits.
pub(crate) async fn notify(
    tx: &mut sqlx::PgConnection,
    account: i64,
    topic: &str,
) -> sqlx::Result<()> {
    sqlx::query("SELECT pg_notify('account_changed',$1)")
        .bind(format!("{account} {topic}"))
        .execute(tx)
        .await
        .map(|_| ())
}

fn account_change(payload: &str) -> Option<(i64, &'static str)> {
    let (account, topic) = payload.split_once(' ')?;
    let topic = TOPICS.into_iter().find(|t| *t == topic)?;
    Some((account.parse().ok().filter(|id| *id > 0)?, topic))
}

pub async fn listen(
    db: PgPool,
    events: broadcast::Sender<()>,
    updates: tokio::sync::watch::Sender<Option<String>>,
    accounts: broadcast::Sender<(i64, &'static str)>,
) {
    // LISTEN holds its connection for the process lifetime, not a read slot.
    let db = sqlx::postgres::PgPoolOptions::new().max_connections(1)
        .connect_lazy_with(db.connect_options().as_ref().clone());
    loop {
        let result = async {
            let mut listener = PgListener::connect_with(&db).await?;
            listener.listen("market_changed").await?;
            listener.listen("collector_update").await?;
            listener.listen("account_changed").await?;
            let _ = events.send(());
            let _ = accounts.send((EVERY_ACCOUNT, TOPICS[0]));
            loop {
                match listener.try_recv().await? {
                    Some(notice) if notice.channel() == "account_changed" => {
                        if let Some(change) = account_change(notice.payload()) {
                            let _ = accounts.send(change);
                        }
                    }
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
            while let Ok(()) | Err(broadcast::error::TryRecvError::Lagged(_)) =
                receiver.try_recv()
            {}
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

struct Feed {
    receiver: broadcast::Receiver<(i64, &'static str)>,
    account: i64,
    device: Option<i64>,
    session: Option<Vec<u8>>,
    tick: tokio::time::Interval,
    db: PgPool,
    pending: Vec<&'static str>,
}
impl Feed {
    /// Revoked devices and ended sessions stop receiving events. A database
    /// error is not a revocation; the next tick checks again.
    async fn alive(&self) -> bool {
        let result = match (self.device, &self.session) {
            (Some(id), _) => sqlx::query(
                "UPDATE account_devices SET last_seen_at=now() WHERE id=$1 AND revoked_at IS NULL",
            )
            .bind(id)
            .execute(&self.db)
            .await
            .map(|r| r.rows_affected() == 1),
            (None, Some(hash)) => sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM account_sessions WHERE token_hash=$1 AND expires_at>now())",
            )
            .bind(hash)
            .fetch_one(&self.db)
            .await,
            (None, None) => Ok(false),
        };
        result.unwrap_or(true)
    }
}

/// Private change notices for one account, to its website session or device.
pub async fn account_events(State(state): State<AppState>, headers: HeaderMap) -> Response {
    use crate::contributors::{cookie, error, internal, session, SESSION};
    let (account, device, session_hash) = if crate::api::bearer(&headers).is_some() {
        match crate::devices::device(&state, &headers).await {
            Ok(d) => (d.account, Some(d.id), None),
            Err(e) => return e,
        }
    } else {
        match session(&state, &headers).await {
            Ok(Some(s)) => (s.id, None, cookie(&headers, SESSION).map(crate::auth::token_hash)),
            Ok(None) => return error(StatusCode::UNAUTHORIZED, "login_required"),
            Err(e) => return e,
        }
    };
    if !state.limiter.allow(&format!("account-events:{account}"), 30) {
        return error(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    }
    if let Some(id) = device {
        if let Err(e) = sqlx::query("UPDATE account_devices SET last_seen_at=now() WHERE id=$1")
            .bind(id)
            .execute(&state.db)
            .await
        {
            return internal(e);
        }
    }
    let period = Duration::from_secs(30);
    let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let feed = Feed {
        receiver: state.account_events.subscribe(),
        account,
        device,
        session: session_hash,
        tick,
        db: state.db.clone(),
        pending: vec!["hello"],
    };
    let changes = stream::unfold(feed, |mut f| async move {
        loop {
            if let Some(topic) = f.pending.pop() {
                let event = Event::default().event(topic).data("{}");
                return Some((Ok::<_, Infallible>(event), f));
            }
            tokio::select! {
                change = f.receiver.recv() => match change {
                    Ok((account, topic)) if account == f.account => f.pending.push(topic),
                    Ok((EVERY_ACCOUNT, _)) | Err(broadcast::error::RecvError::Lagged(_)) => {
                        f.pending = TOPICS.to_vec();
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Closed) => return None,
                },
                _ = f.tick.tick() => {
                    if !f.alive().await {
                        return None;
                    }
                }
            }
        }
    });
    let mut response = Sse::new(changes)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response();
    response
        .headers_mut()
        .insert("x-accel-buffering", "no".parse().unwrap());
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn account_change_payloads_are_strict() {
        assert_eq!(account_change("42 sweep"), Some((42, "sweep")));
        assert_eq!(account_change("7 devices"), Some((7, "devices")));
        for bad in ["42", "42 market", "x data", "0 data", "-3 data", "42  data", ""] {
            assert_eq!(account_change(bad), None, "{bad}");
        }
    }
}
