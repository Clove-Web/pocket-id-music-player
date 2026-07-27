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
    activity::{Activity, ActivityTimestamps},
    enums::ActivityType,
    Client,
};

pub enum PresenceUpdate {
    NowPlaying {
        title: String,
        artist: String,
        album: Option<String>,
        duration_s: Option<f64>,
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
                Ok(PresenceUpdate::NowPlaying { title, artist, album, duration_s }) => {
                    let mut activity = Activity::new();
                    activity.set_activity_type(ActivityType::Listening);
                    activity.set_details(Some(&title));

                    let state = match album {
                        Some(album) => format!("{artist} — {album}"),
                        None => artist,
                    };
                    activity.set_state(Some(&state));

                    if let Some(duration_s) = duration_s {
                        let now_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;
                        let end_ms = now_ms + (duration_s * 1000.0) as u64;

                        let mut timestamps = ActivityTimestamps::new();
                        timestamps.set_start(now_ms);
                        timestamps.set_end(end_ms);
                        activity.set_timestamps(Some(&timestamps));
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
