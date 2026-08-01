package uk.doughmination.music.playback

import java.util.concurrent.CopyOnWriteArrayList

/**
 * Tiny in-process event bus so the playback service can tell the Activity that
 * a **notification / lock-screen** transport button was pressed.
 *
 * The native engine only ever holds the single current track, so "next"/"prev"
 * can't be resolved natively — they have to go back to the web layer, which
 * owns the queue. Service and Activity run in the same process (no
 * android:process on the service), so a plain singleton is enough; no IPC.
 */
object PlaybackBus {
    fun interface TransportListener {
        /** cmd is "next" or "prev". */
        fun onTransport(cmd: String)
    }

    private val listeners = CopyOnWriteArrayList<TransportListener>()

    fun addListener(listener: TransportListener) = listeners.add(listener)
    fun removeListener(listener: TransportListener) = listeners.remove(listener)

    fun emitTransport(cmd: String) = listeners.forEach { it.onTransport(cmd) }
}
