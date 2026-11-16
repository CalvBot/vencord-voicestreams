/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Runs in Discord's main process. Builds the player (player.ts) for each person in the call, under
// their name and with their avatar as its icon, and keeps one running per person.

import { execFile, spawn } from "child_process";
import { createHash } from "crypto";
import { BrowserWindow, IpcMainInvokeEvent, nativeImage, net } from "electron";
import { existsSync } from "fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";

import { PLAYER_CS } from "./player";

export interface Person {
    id: string;
    name: string;
    /** Discord's id of their avatar image, null without one */
    avatar: string | null;
    /** Whether they allow clips in Discord. Their app runs from "clips-on" or "clips-off" by this. */
    allowsClips: boolean;
    /** Their volume in Discord, 100 = normal */
    volume: number;
}

interface Running {
    /** Folder and exe name it was started as (appKey) */
    app: string;
    volume: number;
    /** Renderer pids and output device it was started with */
    args: string;
    /** The loudest sample in each of the player's last few half-second reports */
    peaks: number[];
    /** Whether the player last saw the recorder taking audio */
    recorderMoving: boolean | null;
    /** Process id of the player that is actually playing (the detached copy), once it has said so */
    pid: number | null;
    stopped: boolean;
}

export interface Status {
    error: string | null;
    /** For every person whose player is receiving their stream: the loudest sample of the last ~2 s (0 = silence) */
    levels: Record<string, number>;
    /** False when the players agree that the recorder has stopped taking audio; null if none can tell yet */
    recorderMoving: boolean | null;
}

/** Holds player.exe and the clips-on and clips-off folders with everyone's app */
const DIR = join(process.env.LOCALAPPDATA ?? "", "VoiceStreams");
const PLAYER = join(DIR, "player.exe");
/** Changes with the player's code, so apps built from older code are built again */
const VERSION = createHash("sha1").update(PLAYER_CS).digest("hex").slice(0, 10);
/** The C# compiler that is part of Windows */
const CSC = join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
const RETRY_AFTER_MS = 10_000;

const running = new Map<string, Running>();
/** When a person's player last failed, so it isn't restarted in a tight loop */
const failedAt = new Map<string, number>();
let building: Promise<void> | null = null;
let lastError: string | null = null;

function build() {
    building ??= (async () => {
        if (existsSync(PLAYER) && await readFile(join(DIR, "player.cs"), "utf8").catch(() => null) === PLAYER_CS) return;
        await mkdir(DIR, { recursive: true });
        await writeFile(join(DIR, "player.cs"), PLAYER_CS);
        await promisify(execFile)(CSC, ["-nologo", "-optimize", "-target:winexe", "-out:player.exe", "player.cs"], { cwd: DIR, windowsHide: true });
    })().catch(e => {
        building = null;
        throw new Error(`Could not build the player: ${e?.stdout || e?.message || e}`);
    });
    return building;
}

/**
 * "discord-<username>-<userId>.exe", with anything that isn't safe in a file name replaced. The
 * id makes the name unique and lets other programs tell who it is without guessing from a name.
 * The name is cut to 24 characters so the whole stays under 64 (lifelog keeps exe names in 64 bytes).
 */
function exeName(p: Person) {
    const safe = p.name.normalize("NFKD").replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24);
    return safe ? `discord-${safe}-${p.id}.exe` : `discord-${p.id}.exe`;
}

/** What a player was started as: its folder and name. A change means it runs again from the new one. */
function appKey(p: Person) {
    return `${p.allowsClips ? "clips-on" : "clips-off"}/${exeName(p)}`;
}

function stop(id: string) {
    const r = running.get(id);
    if (!r) return;
    running.delete(id);
    r.stopped = true;
    end(r);
}

/** Ends a player's process. Before it has reported its id, this happens as soon as it does. */
function end(r: Running) {
    if (r.pid == null) return;
    try {
        process.kill(r.pid);
    } catch {
        // already gone
    }
}

/**
 * The person's avatar as a Windows icon file, cut to a circle like Discord shows it. Someone
 * without an avatar gets Discord's default one (its logo on a colour).
 */
async function avatarIcon(p: Person): Promise<Buffer | null> {
    const url = p.avatar
        ? `https://cdn.discordapp.com/avatars/${p.id}/${p.avatar}.png?size=256`
        : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(p.id) >> 22n) % 6n)}.png`;
    const res = await net.fetch(url);
    if (!res.ok) return null;
    const image = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
    if (image.isEmpty()) return null;

    const images: { size: number; data: Buffer; }[] = [];
    for (const size of [16, 24, 32, 48, 64, 256]) {
        // BGRA, top row first
        const px = image.resize({ width: size, height: size, quality: "best" }).toBitmap();
        if (px.length !== size * size * 4) continue;
        const r = size / 2;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                // 1 inside the circle, 0 outside, a soft step on the edge
                const cover = Math.max(0, Math.min(1, r - Math.hypot(x + 0.5 - r, y + 0.5 - r) + 0.5));
                const i = (y * size + x) * 4;
                px[i + 3] = Math.round(px[i + 3] * cover);
                if (!px[i + 3]) px[i] = px[i + 1] = px[i + 2] = 0;
            }
        }
        // Icon images are a bitmap header, the pixels bottom row first, then an (unused) 1-bit mask
        const maskRow = ((size + 31) >> 5) * 4;
        const data = Buffer.alloc(40 + px.length + maskRow * size);
        data.writeUInt32LE(40, 0);
        data.writeInt32LE(size, 4);
        data.writeInt32LE(size * 2, 8);
        data.writeUInt16LE(1, 12);
        data.writeUInt16LE(32, 14);
        data.writeUInt32LE(px.length, 20);
        for (let y = 0; y < size; y++) px.copy(data, 40 + (size - 1 - y) * size * 4, y * size * 4, (y + 1) * size * 4);
        images.push({ size, data });
    }
    if (!images.length) return null;

    const head = Buffer.alloc(6 + 16 * images.length);
    head.writeUInt16LE(1, 2); // icon
    head.writeUInt16LE(images.length, 4);
    let offset = head.length;
    images.forEach(({ size, data }, i) => {
        const e = 6 + i * 16;
        head[e] = size & 0xff; // 256 is written as 0
        head[e + 1] = size & 0xff;
        head.writeUInt16LE(1, e + 4);
        head.writeUInt16LE(32, e + 6);
        head.writeUInt32LE(data.length, e + 8);
        head.writeUInt32LE(offset, e + 12);
        offset += data.length;
    });
    return Buffer.concat([head, ...images.map(i => i.data)]);
}

/** `s` as a C# string literal, every character outside printable ASCII escaped */
function csString(s: string) {
    return `"${s.replace(/[^\x20-\x7e]|["\\]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}

/**
 * Makes the person's own exe. An icon can only be put into an exe when it is built, so each
 * person's copy is compiled with their avatar, and with their name as the exe's description: the
 * name programs that list apps (Task Manager, the volume mixer, lifelog) show it by. It is built
 * again only when the avatar or the name changes.
 */
async function personalExe(p: Person, name: string) {
    // People who turned off clips get their app from a folder of its own, so a program that
    // captures apps can leave that whole folder out
    const dir = join(DIR, p.allowsClips ? "clips-on" : "clips-off");
    await mkdir(dir, { recursive: true });
    const exe = join(dir, name);
    // They may have had an app in the other folder before changing the setting
    const old = join(DIR, p.allowsClips ? "clips-off" : "clips-on", name);
    await rm(old, { force: true }).catch(() => { });
    await rm(`${old}.built`, { force: true }).catch(() => { });
    const keyFile = `${exe}.built`;
    const key = `${VERSION}\n${p.avatar ?? "default"}\n${p.name}`;
    if (existsSync(exe) && await readFile(keyFile, "utf8").catch(() => null) === key) return exe;
    const title = `${exe}.title.cs`;
    try {
        await writeFile(title, `[assembly: System.Reflection.AssemblyTitle(${csString(p.name || p.id)})]\n`);
        const icon = await avatarIcon(p).catch(() => null);
        if (icon) await writeFile(`${exe}.ico`, icon);
        await promisify(execFile)(CSC, ["-nologo", "-optimize", "-target:winexe", `-out:${exe}`, ...(icon ? [`-win32icon:${exe}.ico`] : []), "player.cs", title], { cwd: DIR, windowsHide: true });
        // Without an avatar it is tried again next time
        if (icon) await writeFile(keyFile, key);
    } catch {
        // An old copy is still running, or the compiler failed: a plain copy still works
        if (!existsSync(exe)) await copyFile(PLAYER, exe).catch(() => { });
    } finally {
        // The exe holds the icon and the name now
        await rm(`${exe}.ico`, { force: true }).catch(() => { });
        await rm(title, { force: true }).catch(() => { });
    }
    return exe;
}

async function start(p: Person, pids: string, device: string) {
    const name = exeName(p);
    const exe = await personalExe(p, name);
    // With --detach the player starts itself again and the first copy exits, so the one that plays
    // is no longer a child of Discord. Programs that capture an app together with everything it
    // started (lifelog, OBS) would otherwise pick every person up a second time as part of Discord.
    // The copy keeps the output pipes, exits by itself when Discord is gone, and is stopped by its
    // process id when its person leaves.
    const proc = spawn(exe, ["--detach", pids, p.id], {
        cwd: DIR,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, VOICESTREAMS_DEVICE: device, VOICESTREAMS_OWNER: String(process.pid), VOICESTREAMS_VOLUME: String(p.volume) },
    });
    const r: Running = { app: appKey(p), volume: p.volume, args: `${pids}|${device}`, peaks: [], recorderMoving: null, pid: null, stopped: false };
    running.set(p.id, r);
    proc.stdout!.on("data", d => {
        const pid = /^P (\d+)/m.exec(String(d));
        if (pid) {
            r.pid = Number(pid[1]);
            if (r.stopped) end(r);
        }
        for (const m of String(d).matchAll(/^A ([01])/gm)) r.recorderMoving = m[1] === "1";
        for (const m of String(d).matchAll(/^L (-?\d+)/gm)) r.peaks.push(Number(m[1]));
        r.peaks.splice(0, Math.max(0, r.peaks.length - 4));
    });
    let stderr = "";
    proc.stderr!.on("data", d => { stderr = (stderr + d).slice(-500); });
    proc.on("error", e => { stderr = e.message; });
    proc.on("close", code => {
        if (running.get(p.id) !== r) return; // we stopped it
        running.delete(p.id);
        failedAt.set(p.id, Date.now());
        lastError = `${name} stopped: ${stderr.trim() || `exit code ${code}`}`;
    });
}

/**
 * Called every couple of seconds with who is in the call (null when not in one). Starts a player
 * for everyone new and stops the players of people who left. Returns the latest problem, if any,
 * and how loud each running player's stream is.
 */
export async function update(e: IpcMainInvokeEvent, device: string, inCall: Person[] | null): Promise<Status> {
    if (!inCall?.length) {
        for (const id of [...running.keys()]) stop(id);
        failedAt.clear();
        lastError = null;
        return { error: null, levels: {}, recorderMoving: null };
    }
    await build();
    // The streams are named after the process that hosts the voice engine (this window's renderer)
    const pids = `${e.sender.getOSProcessId()},${process.pid}`;
    const args = `${pids}|${device}`;
    const want = new Map(inCall
        .filter(p => /^\d{1,20}$/.test(p.id) && /^\w*$/.test(p.avatar ?? ""))
        .map(p => [p.id, { ...p, allowsClips: p.allowsClips === true, volume: Math.round(Math.min(200, Math.max(0, Number(p.volume) || 0))) }]));

    for (const [id, r] of [...running]) {
        const p = want.get(id);
        // Left the call, or something the player was started with changed
        if (!p || r.args !== args || r.app !== appKey(p) || r.volume !== p.volume) stop(id);
    }
    const now = Date.now();
    for (const p of want.values()) {
        if (running.has(p.id) || now - (failedAt.get(p.id) ?? 0) < RETRY_AFTER_MS) continue;
        await start(p, pids, device);
    }
    const error = lastError;
    if (running.size === want.size) lastError = null;
    const levels: Record<string, number> = {};
    // Only players whose stream is arriving right now (their latest report isn't "no stream")
    for (const [id, r] of running) if (r.peaks.length && r.peaks[r.peaks.length - 1] >= 0) levels[id] = Math.max(...r.peaks);
    const seen = [...running.values()].map(r => r.recorderMoving).filter(m => m != null);
    return { error, levels, recorderMoving: seen.length ? seen.some(Boolean) : null };
}

/** Discord's own window handle, as Discord writes it in a clips source id ("window:<hwnd>"). */
export function getWindowHandle(e: IpcMainInvokeEvent): string {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) throw new Error("No window");
    const h = win.getNativeWindowHandle();
    return (h.length >= 8 ? h.readBigUInt64LE(0) : BigInt(h.readUInt32LE(0))).toString();
}
