/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Gives every person in a voice call their own live audio stream, as their own app.
//
// Discord's voice engine passes each person's audio separately to its Clips recorder. While you
// are in a call this plugin keeps that recorder running (with Discord's own window as the video
// source, so no game is needed), and the native side runs one small player per person
// ("discord-<username>-<userId>.exe") that reads that person's stream as it happens and plays it
// on Discord's output device. Discord itself stops playing a person while their app does.

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findStoreLazy } from "@webpack";
import {
    FluxDispatcher, MediaEngineStore, RTCConnectionStore,
    SelectedChannelStore, UserStore, VoiceStateStore,
} from "@webpack/common";

const logger = new Logger("VoiceStreams");
const ClipsStore = findStoreLazy("ClipsStore");
const SpeakingStore = findStoreLazy("SpeakingStore");
const Native = VencordNative.pluginHelpers.VoiceStreams as PluginNative<typeof import("./native")>;

const TICK_MS = 2000;
/** With the recorder not taking audio for this long in a call, it is started again */
const RESTART_AFTER_MS = 8000;
const REINIT_EVERY_MS = 15_000;

const settings = definePluginSettings({
    includeSelf: {
        type: OptionType.BOOLEAN,
        description: "Also run an app for your own voice.",
        default: false,
    },
    includeBots: {
        type: OptionType.BOOLEAN,
        description: "Also run apps for bots.",
        default: true,
    },
});

declare const DiscordNative: {
    nativeModules: {
        ensureModule(name: string): Promise<void>;
        requireModule(name: string): any;
    };
    fileManager: { getClipsDataDirSync(): string; };
};

const engine = () => MediaEngineStore.getMediaEngine() as any;
const recorderReady = () => !!(MediaEngineStore as any).isClipsRecordingReady?.();

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;
/** Voice channel we're set up for */
let channel: string | null = null;
/** When the recorder was last seen taking audio */
let lastMoving = 0;
let lastError: string | null = null;

/** Our clips source id, and whether it's the one Discord is recording right now */
let ourSourceId: string | null = null;
let sourceIsOurs = false;
let lastInit = 0;

/** People Discord is currently not playing because their app is */
const silenced = new Set<string>();
/** How many ticks someone was talking while their app heard nothing, since it last heard them */
const missed = new Map<string, number>();
/** Loudest sample (of 32767) under which a stream counts as silent */
const SILENT_BELOW = 30;
const GIVE_BACK_AFTER_TICKS = 3;

/** When each person was last asked for again because their app had no stream */
const askedAgain = new Map<string, number>();
const ASK_AGAIN_EVERY_MS = 30_000;

/** People we told Discord to record, and on which connection */
const overrides = new Set<string>();
let overrideConn: unknown = null;

async function startRecording(force = false) {
    if (!force && recorderReady()) return; // something (a game, or us) is already recording
    if (Date.now() - lastInit < REINIT_EVERY_MS) return;
    lastInit = Date.now();

    const nm = DiscordNative.nativeModules;
    await nm.ensureModule("discord_clips");
    const me = engine();
    me.setClipsDataPath(DiscordNative.fileManager.getClipsDataDirSync());
    me.setClipsModulePath(nm.requireModule("discord_clips").getModulePath());
    me.setClipsRecordingEnabled(true);
    // Without a buffer length the recorder refuses to start ("invalid recording parameters")
    me.setClipBufferLength(120);

    ourSourceId = `window:${await Native.getWindowHandle()}`;
    logger.info("Starting the clips recorder on", ourSourceId);
    // Same event Discord fires for a game, so its own code sets up the source
    FluxDispatcher.dispatch({
        type: "CLIPS_INIT",
        sourceId: ourSourceId,
        applicationName: "Discord",
        quality: { resolution: 480, frameRate: 15, bitratePercent: 25 },
    });
}

function stopRecording() {
    if (!sourceIsOurs) return; // a game took over; leave it alone
    logger.info("Stopping the clips recorder");
    const me = engine();
    me.setClipsSource(null);
    me.setClipsRecordingEnabled(false);
    sourceIsOurs = false;
}

/** Who gets an app: everyone in the channel, minus you and bots if those are turned off. */
function peopleIn(channelId: string) {
    const selfId = UserStore.getCurrentUser()?.id;
    return Object.keys(VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {})
        .filter(id => id === selfId ? settings.store.includeSelf : settings.store.includeBots || !UserStore.getUser(id)?.bot)
        // The account's username, not a nickname: it's the same in every server and rarely changes
        .map(id => {
            const user = UserStore.getUser(id);
            // Decides the folder the app runs from (clips-on or clips-off). Your own voice is yours
            // to record; everyone else, bots included, goes by what Discord would do by itself.
            const allowsClips = id === selfId || !!ClipsStore.isVoiceRecordingAllowedForUser?.(id);
            // The volume you set for them in Discord (100 = normal, up to 200), played by their app
            const volume: number = (MediaEngineStore as any).getLocalVolume?.(id) ?? 100;
            return { id, name: user?.username ?? "", avatar: user?.avatar ?? null, allowsClips, volume };
        });
}

/**
 * Tells Discord to hand everyone who should have an app to the recorder. By itself it leaves out
 * you, bots and people who turned off "allow clips", so those would have no stream.
 *
 * This only separates their audio on this PC, the same audio Discord already plays here. Nothing
 * is saved by this plugin. Whether a person's app gets recorded is up to whatever captures it, and
 * a person who shouldn't be recorded can now be left out by app, which wasn't possible while they
 * were mixed into Discord's own sound.
 */
function applyOverrides(ids: string[]) {
    const conn = RTCConnectionStore.getRTCConnection?.();
    if (conn !== overrideConn) {
        // A new voice connection starts from Discord's defaults
        overrideConn = conn;
        overrides.clear();
    }
    if (!conn?.setClipRecordUser) return;
    const selfId = UserStore.getCurrentUser()?.id;
    const want = new Set(ids);
    for (const id of want) {
        if (!overrides.has(id)) {
            conn.setClipRecordUser(id, "audio", true);
            overrides.add(id);
        }
    }
    for (const id of overrides) {
        if (!want.has(id)) {
            // Back to what Discord would do by itself
            const own = id !== selfId && !UserStore.getUser(id)?.bot && !!ClipsStore.isVoiceRecordingAllowedForUser?.(id);
            conn.setClipRecordUser(id, "audio", own);
            overrides.delete(id);
        }
    }
}

/**
 * Discord sets everyone's saved volume on the voice connection again whenever its audio settings
 * change (turning a stream's sound on or off is enough), which would play a silenced person
 * through Discord again until the next tick. Any volume set for them on this connection becomes 0
 * instead, at once. Their stream's sound is on a separate connection and isn't touched.
 */
function holdSilence(c: any) {
    if (c.voiceStreamsHold) return;
    c.voiceStreamsHold = true;
    const set = c.setLocalVolume;
    c.setLocalVolume = function (id: string, volume: number, ...rest: unknown[]) {
        return set.call(this, id, silenced.has(id) ? 0 : volume, ...rest);
    };
}

/**
 * Stops or resumes Discord playing someone, on the voice connection only: Discord's own settings
 * and UI don't change. It is done with the volume, not a mute: a muted person's stream stops
 * arriving (Discord stops decoding them), while at volume 0 it keeps arriving at full level.
 */
function setDiscordSilent(id: string, silent: boolean) {
    engine().eachConnection?.((c: any) => {
        if (c.context !== "default") return;
        holdSilence(c);
        if (silent) {
            c.setLocalVolume(id, 0);
        } else {
            // Back to the volume Discord's settings have for them (100 = normal)
            c.setLocalVolume(id, (MediaEngineStore as any).getLocalVolume?.(id) ?? 100);
        }
    });
}

/**
 * Stops Discord playing the people whose own app is playing them, so each is heard once. Discord
 * keeps playing everyone else: you, people whose app has no stream or isn't working, and anything
 * that isn't a voice, like a screen share's sound.
 *
 * If Discord says someone is talking while their app hears nothing for a few seconds,
 * Discord plays them again until their app hears them.
 */
function applySilence(levels: Record<string, number>) {
    const selfId = UserStore.getCurrentUser()?.id;
    const want = new Set<string>();
    // `levels` only has the people whose app is receiving their stream right now
    for (const id of Object.keys(levels)) {
        if (id === selfId) continue;
        if (levels[id] >= SILENT_BELOW) missed.delete(id);
        else if (SpeakingStore.isSpeaking?.(id)) missed.set(id, (missed.get(id) ?? 0) + 1);
        if ((missed.get(id) ?? 0) >= GIVE_BACK_AFTER_TICKS) continue;
        want.add(id);
    }
    // Every tick, not only on changes: Discord sets its own value again now and then
    // `silenced` is updated first: holdSilence reads it
    for (const id of want) {
        silenced.add(id);
        setDiscordSilent(id, true);
    }
    for (const id of [...silenced]) {
        if (want.has(id)) continue;
        silenced.delete(id);
        setDiscordSilent(id, false);
    }
}

/**
 * The device Discord itself plays voices on, as the start of its name (which is what the player
 * can look a device up by; Windows gives it only the first 31 characters). Empty = Windows'
 * default device, also Discord's own choice when it is set to "Default".
 */
function outputDevice() {
    const store = MediaEngineStore as any;
    const id = store.getOutputDeviceId?.();
    const name: string = id && id !== "default" ? store.getOutputDevices?.()?.[id]?.name ?? "" : "";
    return name.slice(0, 31);
}

function leave() {
    if (!channel) return;
    channel = null;
    applySilence({});
    missed.clear();
    askedAgain.clear();
    applyOverrides([]);
    stopRecording();
    logger.info("Left the call");
}

function report(error: string | null) {
    if (error && error !== lastError) logger.error(error);
    lastError = error;
}

async function tick() {
    if (busy) return;
    busy = true;
    try {
        const channelId = SelectedChannelStore.getVoiceChannelId() ?? null;
        if (channel && channel !== channelId) leave();
        if (!channelId) {
            await Native.update(outputDevice(), null);
            return;
        }
        const people = peopleIn(channelId);
        applyOverrides(people.map(p => p.id));
        if (!channel) {
            channel = channelId;
            lastMoving = Date.now();
            logger.info("Joined a call, starting an app per person");
            await startRecording();
        }
        const status = await Native.update(outputDevice(), people);
        report(status.error);
        applySilence(status.levels);
        // Discord sets its own choice again now and then (a setting changed, people merged), which
        // stops a stream we asked for. Ask again for anyone whose app has no stream, at most every
        // 30 s each.
        for (const p of people) {
            if (p.id in status.levels || Date.now() - (askedAgain.get(p.id) ?? 0) < ASK_AGAIN_EVERY_MS) continue;
            askedAgain.set(p.id, Date.now());
            overrides.delete(p.id);
        }
        // Judged by audio actually moving, not by Discord's "ready" flag: the recorder can be
        // "ready" and still not take any audio (it waits for a first video frame), and then every
        // stream stands still.
        if (status.recorderMoving !== false) {
            lastMoving = Date.now();
        } else if (Date.now() - lastMoving > RESTART_AFTER_MS && Date.now() - lastInit > REINIT_EVERY_MS) {
            lastMoving = Date.now();
            logger.warn("The recorder isn't taking audio, starting it again");
            // Fully off first, with a pause, so the capture is really set up again
            engine().setClipsSource(null);
            await new Promise(r => setTimeout(r, 1000));
            await startRecording(true);
        }
    } catch (e) {
        logger.error("Tick failed", e);
    } finally {
        busy = false;
    }
}

export default definePlugin({
    name: "VoiceStreams",
    description: "Runs one small app per person in a voice call (discord-<username>-<userId>.exe) that plays only that person's voice, so each can be captured or mixed on its own. You hear people through their apps instead of through Discord; anyone without a working app is still played by Discord. This includes people who turned off \"allow clips\": it is up to you not to record them.",
    authors: [{ name: "CalvBot", id: 0n }],
    settings,

    flux: {
        CLIPS_INIT(e: { sourceId?: string; }) {
            sourceIsOurs = e.sourceId != null && e.sourceId === ourSourceId;
        },
    },

    start() {
        timer = setInterval(tick, TICK_MS);
        tick();
    },

    async stop() {
        if (timer) clearInterval(timer);
        timer = null;
        // Wait for a running tick so it doesn't start things again after this
        while (busy) await new Promise(r => setTimeout(r, 100));
        leave();
        await Native.update(outputDevice(), null);
    },
});
