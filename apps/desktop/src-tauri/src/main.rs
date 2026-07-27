#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod discord;

use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;

use discord::PresenceUpdate;
use tauri::{Manager, State};

// TODO: replace with your own Discord application ID from
// https://discord.com/developers/applications — Rich Presence tab.
const DISCORD_APPLICATION_ID: u64 = 0;

struct DiscordHandle(Mutex<Sender<PresenceUpdate>>);

#[tauri::command]
fn set_now_playing(
    title: String,
    artist: String,
    album: Option<String>,
    #[allow(non_snake_case)] durationS: Option<f64>,
    handle: State<DiscordHandle>,
) -> Result<(), String> {
    handle
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .send(PresenceUpdate::NowPlaying {
            title,
            artist,
            album,
            duration_s: durationS,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_presence(handle: State<DiscordHandle>) -> Result<(), String> {
    handle
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .send(PresenceUpdate::Clear)
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let (tx, rx) = mpsc::channel::<PresenceUpdate>();
            discord::spawn(DISCORD_APPLICATION_ID, rx);
            app.manage(DiscordHandle(Mutex::new(tx)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![set_now_playing, clear_presence])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
