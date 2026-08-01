package uk.doughmination.music.playback

import android.webkit.CookieManager
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.HttpDataSource

/**
 * HTTP data source factory that injects the WebView's session cookie into every
 * request, so ExoPlayer (and the notification's cover-art loader) can fetch the
 * same auth-gated URLs the logged-in WebView can.
 *
 * `CookieManager` is process-global and the service shares the WebView's
 * process, so the cookie set during the in-WebView login is visible here. The
 * cookie is read per-`open()` because it depends on the request host and can be
 * refreshed at any time.
 */
@UnstableApi
class CookieDataSourceFactory : DataSource.Factory {

    override fun createDataSource(): DataSource {
        val http: HttpDataSource = DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(true)
            .setUserAgent("DoughminationMusic/1.0 (Android)")
            .createDataSource()

        // Delegate everything to the real HTTP source; only hook open() to set
        // the Cookie header just-in-time for the URL being requested.
        return object : DataSource by http {
            override fun open(dataSpec: DataSpec): Long {
                val cookie = CookieManager.getInstance().getCookie(dataSpec.uri.toString())
                if (!cookie.isNullOrEmpty()) {
                    http.setRequestProperty("Cookie", cookie)
                }
                return http.open(dataSpec)
            }
        }
    }
}
