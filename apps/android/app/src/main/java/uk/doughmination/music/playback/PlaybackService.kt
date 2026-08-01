package uk.doughmination.music.playback

import android.content.Intent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSourceBitmapLoader
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.MoreExecutors
import uk.doughmination.music.R
import java.util.concurrent.Executors

/**
 * Foreground media service that actually plays audio. Media3 turns this into a
 * real system MediaSession, which is what gives us reliable background/locked
 * playback plus the notification and lock-screen controls — the things a bare
 * WebView can't provide.
 */
@UnstableApi
class PlaybackService : MediaSessionService() {

    private var mediaSession: MediaSession? = null

    override fun onCreate() {
        super.onCreate()

        val audioAttributes = AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build()

        val exoPlayer = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(CookieDataSourceFactory()))
            // handleAudioFocus = true: pause on calls / other apps, duck, etc.
            .setAudioAttributes(audioAttributes, /* handleAudioFocus = */ true)
            .setHandleAudioBecomingNoisy(true) // pause when headphones unplugged
            .setWakeMode(C.WAKE_MODE_NETWORK) // keep CPU + wifi alive while playing
            .build()

        // Cover art for the notification is fetched with the WebView's cookie
        // too, so auth-gated artwork loads.
        val bitmapLoader = DataSourceBitmapLoader(
            MoreExecutors.listeningDecorator(Executors.newSingleThreadExecutor()),
            CookieDataSourceFactory(),
        )

        mediaSession = MediaSession.Builder(this, QueuePlayer(exoPlayer))
            .setBitmapLoader(bitmapLoader)
            .build()

        setMediaNotificationProvider(
            DefaultMediaNotificationProvider.Builder(this).build().apply {
                setSmallIcon(R.drawable.ic_stat_music)
            },
        )
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? =
        mediaSession

    // If the user swipes the app from recents while nothing is playing, tear the
    // service down so no stale notification lingers. If music is still playing,
    // let it keep going in the background.
    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = mediaSession?.player
        if (player == null || !player.playWhenReady || player.mediaItemCount == 0) {
            stopSelf()
        }
    }

    override fun onDestroy() {
        mediaSession?.run {
            player.release()
            release()
        }
        mediaSession = null
        super.onDestroy()
    }
}
