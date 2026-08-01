package uk.doughmination.music

import android.Manifest
import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import org.json.JSONObject
import uk.doughmination.music.playback.PlaybackBus
import uk.doughmination.music.playback.PlaybackService

/**
 * Hosts the web player in a WebView and bridges its transport calls to a native
 * Media3 [MediaController]. The WebView owns the UI + queue; native owns audio,
 * the foreground service, and the notification / lock-screen controls.
 *
 * See BRIDGE.md for the web ⇄ native contract.
 */
@UnstableApi
class MainActivity : AppCompatActivity(), WebBridge.Host {

    private lateinit var webView: WebView

    private var controller: MediaController? = null
    private lateinit var controllerFuture: ListenableFuture<MediaController>

    // Commands that arrived before the controller finished connecting.
    private val pending = ArrayList<(MediaController) -> Unit>()

    private val mainHandler = Handler(Looper.getMainLooper())
    private var ticking = false

    // Fire onReady() once per new track (STATE_READY can re-fire after seeks).
    private var awaitingReady = false

    private val requestNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* best-effort */ }

    private val transportListener = PlaybackBus.TransportListener { cmd ->
        // From a notification/lock-screen button → hand to the web queue.
        runOnUiThread { evalNative("onTransport", JSONObject.quote(cmd)) }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadsImagesAutomatically = true
            useWideViewPort = true
            loadWithOverviewMode = true
        }
        // Keep all navigation (including the OIDC login redirect) inside the
        // WebView so the session cookie is set on our origin.
        webView.webViewClient = WebViewClient()
        webView.addJavascriptInterface(WebBridge(this), "DmndNative")

        if (savedInstanceState == null) {
            webView.loadUrl(BuildConfig.SITE_URL)
        } else {
            webView.restoreState(savedInstanceState)
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })

        requestNotificationPermission()
        PlaybackBus.addListener(transportListener)
    }

    override fun onStart() {
        super.onStart()
        val token = SessionToken(this, ComponentName(this, PlaybackService::class.java))
        controllerFuture = MediaController.Builder(this, token).buildAsync()
        controllerFuture.addListener({
            val c = controllerFuture.get()
            controller = c
            c.addListener(playerListener)
            // Flush anything the web layer asked for while we were connecting.
            pending.forEach { it(c) }
            pending.clear()
        }, ContextCompat.getMainExecutor(this))
    }

    override fun onStop() {
        stopTicker()
        controller?.removeListener(playerListener)
        MediaController.releaseFuture(controllerFuture)
        controller = null
        super.onStop()
    }

    override fun onDestroy() {
        PlaybackBus.removeListener(transportListener)
        webView.destroy()
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    // ---- WebBridge.Host: web → native (marshalled onto the main thread) ----

    override fun cmdSetTrack(url: String, metadataJson: String, autoplay: Boolean) =
        withController { c ->
            val meta = runCatching { JSONObject(metadataJson) }.getOrNull()
            val builder = MediaMetadata.Builder()
            meta?.optString("title")?.takeIf { it.isNotEmpty() }?.let { builder.setTitle(it) }
            meta?.optString("artist")?.takeIf { it.isNotEmpty() }?.let { builder.setArtist(it) }
            meta?.optString("album")?.takeIf { it.isNotEmpty() }?.let { builder.setAlbumTitle(it) }
            meta?.optString("coverUrl")?.takeIf { it.isNotEmpty() }
                ?.let { builder.setArtworkUri(Uri.parse(it)) }

            val item = MediaItem.Builder()
                .setUri(url)
                .setMediaMetadata(builder.build())
                .build()

            awaitingReady = true
            c.setMediaItem(item)
            c.prepare()
            c.playWhenReady = autoplay
        }

    override fun cmdPlay() = withController { it.play() }

    override fun cmdPause() = withController { it.pause() }

    override fun cmdSeek(seconds: Double) =
        withController { it.seekTo((seconds * 1000).toLong().coerceAtLeast(0)) }

    override fun cmdSetVolume(volume: Double) =
        withController { it.volume = volume.toFloat().coerceIn(0f, 1f) }

    // ---- native → web ----

    private val playerListener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            when (playbackState) {
                Player.STATE_READY -> {
                    if (awaitingReady) {
                        awaitingReady = false
                        evalNative("onReady")
                    }
                    pushPosition()
                }
                Player.STATE_ENDED -> {
                    stopTicker()
                    evalNative("onEnded")
                }
            }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (isPlaying) {
                evalNative("onPlay")
                startTicker()
            } else {
                evalNative("onPause")
                stopTicker()
                pushPosition()
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            evalNative("onError", JSONObject.quote(error.errorCodeName))
        }
    }

    private val ticker = object : Runnable {
        override fun run() {
            pushPosition()
            if (ticking) mainHandler.postDelayed(this, 500)
        }
    }

    private fun startTicker() {
        if (ticking) return
        ticking = true
        mainHandler.post(ticker)
    }

    private fun stopTicker() {
        ticking = false
        mainHandler.removeCallbacks(ticker)
    }

    private fun pushPosition() {
        val c = controller ?: return
        val pos = c.currentPosition.coerceAtLeast(0) / 1000.0
        val rawDur = c.duration
        val dur = if (rawDur == C.TIME_UNSET || rawDur < 0) 0.0 else rawDur / 1000.0
        evalNative("onPosition", pos.toString(), dur.toString())
    }

    /** Calls window.__dmndNative.<method>(<args>) on the page, if present. */
    private fun evalNative(method: String, vararg args: String) {
        val js = "window.__dmndNative && window.__dmndNative.$method(${args.joinToString(", ")});"
        webView.evaluateJavascript(js, null)
    }

    // JS-bridge calls arrive on a WebView binder thread, but MediaController
    // must be used on the main thread — so every command hops here first.
    // `pending` and `controller` are therefore only touched on the main thread.
    private inline fun withController(crossinline action: (MediaController) -> Unit) {
        runOnUiThread {
            val c = controller
            if (c != null) action(c) else pending.add { action(it) }
        }
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            requestNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}
