// Owns the Discord Social SDK `Client` on a single dedicated thread — the
// SDK is callback-driven and expects to be pumped from one thread only
// (see the discord_social_sdk README, "Threading"). Everything else talks
// to it through `PresenceUpdate` messages over an mpsc channel.
//
// Rich Presence works without OAuth/Client::Connect() as long as a Discord
// desktop client is running locally — see "Rich Presence Without
// Authentication" in Discord's docs. We only ever call SetApplicationId +
// UpdateRichPresence, nothing that needs a signed-in session.
//
// NOTE: exact method names below (set_application_id / update_rich_presence
// / clear_rich_presence, Activity's setters) are the Rust wrapper's mapping
// of the C++ SDK — https://docs.discord.com/developers/discord-social-sdk.
// The crate publishes its generated docs on GitHub Pages, not docs.rs
// (https://safeshows.github.io/discord_social_sdk/), because it can't be
// built without Discord's SDK headers. Run `cargo doc --open` locally once
// the SDK is downloaded and cross-check these names before you build.

use std::sync::mpsc::{Receiver, TryRecvError};
use std::thread;
use std::time::Duration;

use discord_social_sdk::{
    activity::{Activity, ActivityTimestamps},
    enums::ActivityTypes,
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
                    activity.set_type(ActivityTypes::Listening);
                    activity.set_details(Some(title));
                    let state = match album {
                        Some(album) => format!("{artist} — {album}"),
                        None => artist,
                    };
                    activity.set_state(Some(state));

                    if let Some(duration_s) = duration_s {
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs();
                        let mut timestamps = ActivityTimestamps::new();
                        timestamps.set_start(Some(now));
                        timestamps.set_end(Some(now + duration_s as u64));
                        activity.set_timestamps(Some(timestamps));
                    }

                    client.update_rich_presence(activity, |_result| {});
                }
                Ok(PresenceUpdate::Clear) => {
                    client.clear_rich_presence(|_result| {});
                }
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => break,
            }

            thread::sleep(Duration::from_millis(16));
        }
    });
}
