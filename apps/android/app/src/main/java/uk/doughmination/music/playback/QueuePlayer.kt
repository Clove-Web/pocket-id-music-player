package uk.doughmination.music.playback

import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi

/**
 * The native engine holds only the *current* track, so by default Media3 would
 * hide the previous/next buttons and never fire them. This wrapper always
 * advertises the seek-to-next / seek-to-previous commands (so the notification
 * and lock screen show both buttons) and, instead of moving within a native
 * playlist, forwards the press to the web layer via [PlaybackBus]. The web
 * player then picks the correct next/previous song and calls `setTrack` again.
 *
 * play / pause / seek-within-track fall through to the real ExoPlayer unchanged.
 */
@UnstableApi
class QueuePlayer(player: Player) : ForwardingPlayer(player) {

    override fun getAvailableCommands(): Player.Commands =
        super.getAvailableCommands()
            .buildUpon()
            .add(Player.COMMAND_SEEK_TO_NEXT)
            .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
            .add(Player.COMMAND_SEEK_TO_PREVIOUS)
            .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
            .build()

    override fun isCommandAvailable(command: Int): Boolean = when (command) {
        Player.COMMAND_SEEK_TO_NEXT,
        Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
        Player.COMMAND_SEEK_TO_PREVIOUS,
        Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
        -> true
        else -> super.isCommandAvailable(command)
    }

    override fun hasNextMediaItem(): Boolean = true
    override fun hasPreviousMediaItem(): Boolean = true

    override fun seekToNext() = PlaybackBus.emitTransport("next")
    override fun seekToNextMediaItem() = PlaybackBus.emitTransport("next")
    override fun seekToPrevious() = PlaybackBus.emitTransport("prev")
    override fun seekToPreviousMediaItem() = PlaybackBus.emitTransport("prev")
}
