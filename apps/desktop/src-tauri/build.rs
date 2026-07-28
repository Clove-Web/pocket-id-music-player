fn main() {
    tauri_build::build();

    // The Discord SDK is a dylib whose install name is @rpath/… . The sys
    // crate emits -rpath link args, but cargo:rustc-link-arg from a *library*
    // dependency does not propagate to the final binary's link — so the
    // packaged .app ended up with "no LC_RPATH's found" and crashed at launch.
    // Emitting them here (the binary crate's own build script) does affect the
    // binary. Cover both layouts:
    //   - dev:          dylib is staged next to the binary -> @executable_path
    //   - packaged app: dylib copied into Contents/Frameworks -> ../Frameworks
    // (A benign "duplicate -rpath ... ignored" warning may appear on the
    // packaged build; harmless, and kept for safety since this is what got the
    // app launching.)
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path");
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
        println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path");
    }
}
