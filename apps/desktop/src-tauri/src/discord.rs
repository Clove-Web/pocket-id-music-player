// Owns the Discord Social SDK `Client` on a single dedicated thread — the
// SDK is callback-driven and expects to be pumped from one thread only
// (see the discord_social_sdk README, "Threading"). Everything else talks
// to it through `PresenceUpdate` messages over an mpsc channel.
//
// Rich Presence works without OAuth/Client::Connect() as long as a Discord
// desktop client is running locally — see "Rich Presence Without
// Authentication" in Discord's docs. We only ever call SetApplicationId +
// UpdateRichPresence, nothing that needs a signed-in session.

use std::sync::mpsc::{Receiver, TryRecvError};
use std::thread;
use std::time::Duration;

use discord_social_sdk::{
    activity::{Activity, ActivityAssets, ActivityTimestamps},
    enums::ActivityType,
    Client,
};

pub enum PresenceUpdate {
    NowPlaying {
        title: String,
        artist: String,
        album: Option<String>,
        duration_s: Option<f64>,
        // Public, absolute URL of the album cover. Discord fetches this from
        // its own servers to render the large presence image, so it must be
        // reachable without auth (see the public /cover route). Empty/None
        // just falls back to the app's default icon.
        cover_url: Option<String>,
        // Current playback position in seconds, so a resumed track's elapsed
        // bar starts from the right place instead of from zero.
        position_s: Option<f64>,
        // When false (paused) we omit the timestamps entirely, which stops
        // Discord from animating the elapsed/remaining bar past where it is.
        playing: bool,
    },
    Clear,
}

pub fn spawn(application_id: u64, rx: Receiver<PresenceUpdate>) {
    thread::spawn(move || {
        let mut client = Client::new();
        client.set_application_id(application_id);

        loop {
            discord_social_sdk::run_callbacks();

            match rx.try_recv() {
                Ok(PresenceUpdate::NowPlaying { title, artist, album, duration_s, cover_url, position_s, playing }) => {
                    let mut activity = Activity::new();
                    activity.set_activity_type(ActivityType::Listening);
                    activity.set_details(Some(&title));

                    // Borrow album (as_deref) rather than move it — it's also
                    // used below as the large-image tooltip.
                    let state = match album.as_deref() {
                        Some(album) => format!("{artist} — {album}"),
                        None => artist.clone(),
                    };
                    activity.set_state(Some(&state));

                    // Only show the elapsed/remaining bar while actually
                    // playing. When paused we omit timestamps so Discord stops
                    // advancing the bar (it would otherwise keep ticking toward
                    // `end` even though playback is stopped).
                    if playing {
                        if let Some(duration_s) = duration_s {
                            let now_ms = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() as u64;
                            // Anchor `start` back by the current position so the
                            // bar reflects real elapsed time on a resumed track.
                            let position_ms = (position_s.unwrap_or(0.0).max(0.0) * 1000.0) as u64;
                            let start_ms = now_ms.saturating_sub(position_ms);
                            let end_ms = start_ms + (duration_s * 1000.0) as u64;

                            let mut timestamps = ActivityTimestamps::new();
                            timestamps.set_start(start_ms);
                            timestamps.set_end(end_ms);
                            activity.set_timestamps(Some(&timestamps));
                        }
                    }

                    // Album art as the large presence image. large_image takes
                    // an external URL directly (per the SDK docs); large_text
                    // is the hover tooltip (album, or the title as a fallback).
                    if let Some(cover) = cover_url.as_deref().filter(|u| !u.is_empty()) {
                        let mut assets = ActivityAssets::new();
                        assets.set_large_image(Some(cover));
                        let tooltip = album.as_deref().unwrap_or(title.as_str());
                        // The SDK requires large_text to be 2-128 chars.
                        if tooltip.chars().count() >= 2 {
                            assets.set_large_text(Some(tooltip));
                        }
                        activity.set_assets(Some(&assets));
                    }

                    client.update_rich_presence(&mut activity, |_result| {});
                }
                Ok(PresenceUpdate::Clear) => {
                    client.clear_rich_presence();
                }
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => break,
            }

            thread::sleep(Duration::from_millis(16));
        }
    });
}
