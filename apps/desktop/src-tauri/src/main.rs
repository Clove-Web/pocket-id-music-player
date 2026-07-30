// Desktop binary entry point. All the real wiring lives in `run()` (lib.rs)
// so desktop and mobile share one setup — see the note there. Mobile never
// builds this file; it calls `run()` directly through the generated project.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    doughmination_music_lib::run()
}
