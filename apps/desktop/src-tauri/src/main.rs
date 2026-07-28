#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod discord;

use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;

use discord::PresenceUpdate;
use tauri::{Manager, State};

// TODO: replace with your own Discord application ID from
// https://discord.com/developers/applications — Rich Presence tab.
const DISCORD_APPLICATION_ID: u64 = 1531083200548438036;

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
    // `mut` is only used on Windows/Linux (single-instance); harmless on macOS.
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // Windows/Linux deliver a deeplink by launching a *second* process with
    // the URL as an argument. single-instance (with its `deep-link` feature)
    // catches that, focuses the existing window, and hands the URL to the
    // deep-link plugin so the frontend's onOpenUrl handler fires as usual.
    // Must be registered before any other plugin.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            // In dev there's no installer to register the scheme, so do it at
            // runtime. No-op / harmless on macOS, where Info.plist handles it.
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }

            let (tx, rx) = mpsc::channel::<PresenceUpdate>();
            discord::spawn(DISCORD_APPLICATION_ID, rx);
            app.manage(DiscordHandle(Mutex::new(tx)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![set_now_playing, clear_presence])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
