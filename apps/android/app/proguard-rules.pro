# Minification is disabled (see build.gradle.kts), so these are belt-and-braces
# for anyone who flips isMinifyEnabled on later.

# The JS bridge is called reflectively by the WebView — keep its methods.
-keepclassmembers class uk.doughmination.music.WebBridge {
    @android.webkit.JavascriptInterface <methods>;
}

# Media3 / ExoPlayer.
-keep class androidx.media3.** { *; }
-dontwarn androidx.media3.**
