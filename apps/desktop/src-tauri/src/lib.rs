// Shared entry point for every platform.
//
// Desktop launches through `main.rs`, which just calls `run()`. Mobile
// (Android/iOS) has no `main()` — the generated Gradle/Xcode project loads
// this crate as a library and calls `run()` via the `mobile_entry_point`
// macro. Keeping the whole app in `run()` means both paths share one setup.
//
// Discord Rich Presence is desktop-only: the Discord Social SDK ships no
// Android/iOS build (see Cargo.toml), so the `discord` module, its state,
// and its real commands are compiled only under `cfg(desktop)`. Mobile gets
// no-op command stubs with the same names, so the frontend's `invoke()`
// calls resolve cleanly instead of rejecting.

#[cfg(desktop)]
mod discord;

#[cfg(desktop)]
use std::sync::mpsc::{
    self,
    Sender,
};
#[cfg(desktop)]
use std::sync::Mutex;

#[cfg(desktop)]
use tauri::State;

#[cfg(desktop)]
use discord::PresenceUpdate;

// Doughmination Music Discord application ID (Rich Presence).
#[cfg(desktop)]
const DISCORD_APPLICATION_ID: u64 = 1531598882595930143;

#[cfg(desktop)]
struct DiscordHandle(Mutex<Sender<PresenceUpdate>>);

#[cfg(desktop)]
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

#[cfg(desktop)]
#[tauri::command]
fn clear_presence(handle: State<DiscordHandle>) -> Result<(), String> {
    handle
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .send(PresenceUpdate::Clear)
        .map_err(|e| e.to_string())
}

// Mobile stubs — keep the command names AND argument names so `invoke()`
// from the shared web frontend deserializes and resolves cleanly (Tauri
// matches the JS payload keys to these parameter identifiers). Presence is
// a desktop-only nicety, so the bodies just succeed and do nothing.
#[cfg(not(desktop))]
#[tauri::command]
#[allow(unused_variables)]
fn set_now_playing(
    title: String,
    artist: String,
    album: Option<String>,
    #[allow(non_snake_case)] durationS: Option<f64>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(desktop))]
#[tauri::command]
fn clear_presence() -> Result<(), String> {
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `mut` is only used on Windows/Linux (single-instance); harmless elsewhere.
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
        .setup(|_app| {
            // In dev there's no installer to register the scheme, so do it at
            // runtime. No-op / harmless on macOS, where Info.plist handles it,
            // and on mobile, where the manifest/Info.plist do.
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = _app.deep_link().register_all();
            }

            // Spin up the Discord presence thread and hand the frontend a
            // channel to it. Desktop-only — mobile has no Discord SDK.
            #[cfg(desktop)]
            {
                use tauri::Manager;
                let (tx, rx) = mpsc::channel::<PresenceUpdate>();
                discord::spawn(DISCORD_APPLICATION_ID, rx);
                _app.manage(DiscordHandle(Mutex::new(tx)));
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![set_now_playing, clear_presence])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
