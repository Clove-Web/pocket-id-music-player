package uk.doughmination.music

import android.webkit.JavascriptInterface

/**
 * The `window.DmndNative` object the web player calls. Every method just hands
 * off to [Host] (implemented by [MainActivity]), which marshals the call onto
 * the main thread and drives the Media3 MediaController.
 *
 * JavascriptInterface methods run on a WebView JS thread — never touch the
 * player or any UI here directly; that's [Host]'s job.
 *
 * See BRIDGE.md for the full contract.
 */
class WebBridge(private val host: Host) {

    interface Host {
        fun cmdSetTrack(url: String, metadataJson: String, autoplay: Boolean)
        fun cmdPlay()
        fun cmdPause()
        fun cmdSeek(seconds: Double)
        fun cmdSetVolume(volume: Double)
    }

    @JavascriptInterface
    fun setTrack(url: String, metadataJson: String, autoplay: Boolean) =
        host.cmdSetTrack(url, metadataJson, autoplay)

    @JavascriptInterface
    fun play() = host.cmdPlay()

    @JavascriptInterface
    fun pause() = host.cmdPause()

    @JavascriptInterface
    fun seek(seconds: Double) = host.cmdSeek(seconds)

    @JavascriptInterface
    fun setVolume(volume: Double) = host.cmdSetVolume(volume)

    /** Lets the web layer feature-detect the native host synchronously. */
    @JavascriptInterface
    fun ready(): Boolean = true
}
