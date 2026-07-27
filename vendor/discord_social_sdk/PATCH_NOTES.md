# Local patch

Vendored from https://github.com/SafeShows/discord_social_sdk @ 9d745d33
(the exact commit this project's Cargo.lock had pinned).

## Why

`ActivityGamePlatforms` (crates/discord_social_sdk/src/enums.rs) and
`ErrorKind::Other` (crates/discord_social_sdk/src/error.rs) were typed as
`i32`, but bindgen generates `u32` (`c_uint`) for the corresponding raw SDK
type on this target — causing a hard compile error. Both were widened to
`u32` to match. Two files, four lines total — see git blame / diff against
the upstream commit above for the exact change.

## Removing this fork

Once https://github.com/SafeShows/discord_social_sdk fixes this upstream
(worth opening an issue with the compiler output if there isn't one
already), delete `vendor/discord_social_sdk/` and the `[patch]` block in
`apps/desktop/src-tauri/Cargo.toml`, then bump the `discord_social_sdk`
git dependency to the fixed commit.
