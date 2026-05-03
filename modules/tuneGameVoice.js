import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel
} from "@discordjs/voice";
import { synthesizeTts } from "./tuneGameTts.js";

/**
 * Owns a Discord voice connection + audio player and provides high-level
 * helpers for playing pre-rendered audio clips and speaking standalone TTS
 * announcements.
 */
export class VoiceSession {
  constructor() {
    this.connection = null;
    this.audioPlayer = null;
  }

  get isConnected() {
    return Boolean(this.connection && this.audioPlayer);
  }

  /**
   * Join the given voice channel and prepare an audio player.
   * Resolves once the connection is Ready (or quietly returns on failure).
   */
  async join(guild, voiceChannelId) {
    try {
      const voiceChannel = await guild.channels.fetch(voiceChannelId);
      if (!voiceChannel || !voiceChannel.isVoiceBased()) {
        console.warn(`[tuneGameVoice] Voice channel ${voiceChannelId} not found or not voice-based.`);
        return false;
      }

      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
      });

      const player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Play }
      });

      connection.subscribe(player);

      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
      } catch (error) {
        console.warn("[tuneGameVoice] Voice connection failed to become ready:", error.message);
        try { connection.destroy(); } catch {}
        return false;
      }

      this.connection = connection;
      this.audioPlayer = player;
      return true;
    } catch (error) {
      console.warn("[tuneGameVoice] Failed to join voice channel:", error.message);
      return false;
    }
  }

  /** Play an audio file through the player. Returns once playback has started. */
  async playClip(clipFilePath) {
    if (!this.audioPlayer) return;

    try {
      const resource = createAudioResource(clipFilePath, { inputType: StreamType.Arbitrary });
      this.audioPlayer.play(resource);
      await entersState(this.audioPlayer, AudioPlayerStatus.Playing, 5_000).catch(() => {});
    } catch (error) {
      console.warn("[tuneGameVoice] Failed to play clip in voice:", error.message);
    }
  }

  /** Stop the current playback (if any). */
  stopClip() {
    try { this.audioPlayer?.stop(true); } catch {}
  }

  /**
   * Synthesize TTS and play it standalone through the audio player,
   * waiting for it to finish before resolving.
   */
  async speakTts(text) {
    const player = this.audioPlayer;
    if (!player || !text) return;

    const ttsFilePath = await synthesizeTts(text);
    if (!ttsFilePath) return;

    try {
      const resource = createAudioResource(ttsFilePath, { inputType: StreamType.Arbitrary });
      player.play(resource);
      await entersState(player, AudioPlayerStatus.Playing, 5_000).catch(() => {});
      await entersState(player, AudioPlayerStatus.Idle, 30_000).catch(() => {});
    } catch (error) {
      console.warn("[tuneGameVoice] Failed to play TTS in voice:", error.message);
    }
  }

  /** Disconnect and destroy the voice connection. */
  teardown() {
    const player = this.audioPlayer;
    const connection = this.connection;

    this.audioPlayer = null;
    this.connection = null;

    try { player?.stop(true); } catch {}

    if (!connection) return;

    try {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        try { connection.disconnect(); } catch {}
        connection.destroy();
      }
    } catch (error) {
      console.warn("[tuneGameVoice] Failed to teardown voice connection:", error.message);
    }
  }
}
