/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Source of the per-person player. It is compiled with the C# compiler that ships with Windows,
// once per person ("discord-<username>-<userId>.exe", with their avatar as the icon), and started
// for everyone in the call, so each person is their own process playing only their own voice.
//
// Discord's voice engine hands audio to its Clips recorder through one ring buffer per stream,
// in shared memory named "discord-clips-audio-<renderer pid>-<userId>:voice":
//   header:  u32 read index, u32 write index, u32 ring size, then the ring itself
//   frame:   u32 length (of the rest), u64 timestamp ms, u32 channels, u32 sample rate,
//            u32 PCM bytes, then 16-bit PCM (10 ms per frame)
// The player only reads. It follows the write index with its own cursor and plays every new
// frame on the chosen playback device.
//
// Arguments: --detach <pid,pid,...> <userId>. It restarts itself so that it is no longer a child of
// the program that started it. Environment: VOICESTREAMS_DEVICE, the playback device (part of its
// name; empty or unknown = default), VOICESTREAMS_OWNER, the process id it exits with (Discord),
// and VOICESTREAMS_VOLUME, 0 to 200 with 100 = as received (later changes are read from the file
// named by VOICESTREAMS_VOLUME_FILE). It prints "P <its process id>" once, so it can be stopped by id.
// Twice a second it prints "L <peak sample value>" so the plugin can tell sound from silence,
// or "L -1" when no audio arrived at all (no stream, or Discord stopped feeding it), and
// "A 1" or "A 0" for whether the recorder is taking audio at all.

export const PLAYER_CS = `
using System;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Runtime.InteropServices;
using System.Threading;

static class Player {
    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEX {
        public ushort wFormatTag, nChannels;
        public uint nSamplesPerSec, nAvgBytesPerSec;
        public ushort nBlockAlign, wBitsPerSample, cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEHDR {
        public IntPtr lpData;
        public uint dwBufferLength, dwBytesRecorded;
        public IntPtr dwUser;
        public uint dwFlags, dwLoops;
        public IntPtr lpNext, reserved;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WAVEOUTCAPS {
        public ushort wMid, wPid;
        public uint vDriverVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szPname;
        public uint dwFormats;
        public ushort wChannels, wReserved1;
        public uint dwSupport;
    }

    [DllImport("winmm.dll")] static extern uint waveOutGetNumDevs();
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern uint waveOutGetDevCapsW(UIntPtr id, out WAVEOUTCAPS caps, uint size);
    [DllImport("winmm.dll")] static extern uint waveOutOpen(out IntPtr handle, uint id, ref WAVEFORMATEX format, IntPtr callback, IntPtr instance, uint flags);
    [DllImport("winmm.dll")] static extern uint waveOutPrepareHeader(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] static extern uint waveOutWrite(IntPtr handle, IntPtr header, uint size);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string app, System.Text.StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION info);

    // Starts this same program again with the same pipes and exits. The copy's parent is then
    // gone, so it no longer counts as part of whatever started this one (Discord).
    static int Detach(string[] args) {
        string exe = System.Reflection.Assembly.GetEntryAssembly().Location;
        // (char)34 is a double quote; written this way so this source needs no escapes
        string q = ((char)34).ToString();
        System.Text.StringBuilder commandLine = new System.Text.StringBuilder(q + exe + q);
        for (int i = 1; i < args.Length; i++) commandLine.Append(" " + q + args[i].Replace(q, "") + q);
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = 0x100; // use the handles below
        si.hStdInput = GetStdHandle(-10);
        si.hStdOutput = GetStdHandle(-11);
        si.hStdError = GetStdHandle(-12);
        // The pipes may have been handed to us without permission to pass them on
        SetHandleInformation(si.hStdInput, 1, 1);
        SetHandleInformation(si.hStdOutput, 1, 1);
        SetHandleInformation(si.hStdError, 1, 1);
        PROCESS_INFORMATION info;
        if (!CreateProcessW(exe, commandLine, IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero, null, ref si, out info)) {
            Console.Error.WriteLine("Could not start the player (error " + Marshal.GetLastWin32Error() + ")");
            return 3;
        }
        return 0;
    }

    const uint WAVE_MAPPER = 0xFFFFFFFF;
    const uint WHDR_INQUEUE = 0x10;
    const int BUFFERS = 48;
    const int BUFFER_BYTES = 8192;
    const int FLAGS_OFFSET = 24; // dwFlags inside WAVEHDR (64-bit)
    const int LENGTH_OFFSET = 8;

    static IntPtr device;
    static readonly IntPtr[] headers = new IntPtr[BUFFERS];
    static readonly int headerSize = Marshal.SizeOf(typeof(WAVEHDR));

    static MemoryMappedFile file;
    static MemoryMappedViewAccessor view;
    static uint cursor, ringSize;

    // The "0:application" stream is written whenever the recorder is taking audio, whoever is in
    // the call. A stream only moves while the recorder reads it, so this one standing still means
    // the recorder has stalled.
    static MemoryMappedFile appFile;
    static MemoryMappedViewAccessor appView;
    static long lastAppWrite = -1;

    static bool RecorderMoving(string[] pids) {
        long write = -1;
        try {
            if (appView == null) {
                foreach (string pid in pids) {
                    try {
                        appFile = MemoryMappedFile.OpenExisting("discord-clips-audio-" + pid + "-0:application", MemoryMappedFileRights.Read);
                        appView = appFile.CreateViewAccessor(0, 12, MemoryMappedFileAccess.Read);
                        break;
                    } catch (Exception) {
                        if (appFile != null) appFile.Dispose();
                        appFile = null;
                        appView = null;
                    }
                }
            }
            if (appView != null) write = appView.ReadUInt32(4);
        } catch (Exception) { }
        bool moving = write >= 0 && lastAppWrite >= 0 && write != lastAppWrite;
        if (!moving && appView != null) {
            // It may have been replaced by a new stream with the same name: look again next time
            appView.Dispose();
            appFile.Dispose();
            appView = null;
            appFile = null;
        }
        lastAppWrite = write;
        return moving;
    }

    // Exits when the program that owns this player (Discord) is gone
    static void WatchOwner(object pid) {
        try { System.Diagnostics.Process.GetProcessById((int)pid).WaitForExit(); } catch (Exception) { }
        Environment.Exit(0);
    }

    // 0 to 200, 100 = as received. Starts from VOICESTREAMS_VOLUME; when it changes the plugin
    // writes the new number to a file, so the player keeps running (and keeps its place in the
    // volume mixer and in capture tools) instead of being started again. A file, not stdin: the
    // plugin's end of the pipes closes for writing once the first copy has exited (see Detach).
    static volatile int volume = 100;

    static void WatchVolume(object path) {
        DateTime seen = DateTime.MinValue;
        while (true) {
            try {
                DateTime changed = System.IO.File.GetLastWriteTimeUtc((string)path);
                int v;
                // A file that doesn't exist has a date long ago, which never counts as newer
                if (changed > seen && changed.Year > 2000 && int.TryParse(System.IO.File.ReadAllText((string)path).Trim(), out v)) {
                    volume = Math.Max(0, Math.Min(200, v));
                    seen = changed;
                }
            } catch (Exception) { }
            Thread.Sleep(150);
        }
    }

    static bool OpenDevice(string wanted) {
        uint id = WAVE_MAPPER;
        if (wanted.Length > 0) {
            bool found = false;
            uint n = waveOutGetNumDevs();
            for (uint i = 0; i < n && !found; i++) {
                WAVEOUTCAPS caps;
                if (waveOutGetDevCapsW((UIntPtr)i, out caps, (uint)Marshal.SizeOf(typeof(WAVEOUTCAPS))) != 0) continue;
                if (caps.szPname.IndexOf(wanted, StringComparison.OrdinalIgnoreCase) >= 0) {
                    id = i;
                    found = true;
                }
            }
            // Not found (unplugged, or named differently): the default device, id stays WAVE_MAPPER
        }
        WAVEFORMATEX f = new WAVEFORMATEX();
        f.wFormatTag = 1;
        f.nChannels = 2;
        f.nSamplesPerSec = 48000;
        f.wBitsPerSample = 16;
        f.nBlockAlign = 4;
        f.nAvgBytesPerSec = 48000 * 4;
        uint err = waveOutOpen(out device, id, ref f, IntPtr.Zero, IntPtr.Zero, 0);
        if (err != 0) {
            Console.Error.WriteLine("Could not open the playback device (error " + err + ")");
            return false;
        }
        for (int i = 0; i < BUFFERS; i++) {
            IntPtr h = Marshal.AllocHGlobal(headerSize);
            WAVEHDR hdr = new WAVEHDR();
            hdr.lpData = Marshal.AllocHGlobal(BUFFER_BYTES);
            hdr.dwBufferLength = BUFFER_BYTES;
            Marshal.StructureToPtr(hdr, h, false);
            waveOutPrepareHeader(device, h, (uint)headerSize);
            headers[i] = h;
        }
        return true;
    }

    static int Queued() {
        int n = 0;
        for (int i = 0; i < BUFFERS; i++) {
            if (((uint)Marshal.ReadInt32(headers[i], FLAGS_OFFSET) & WHDR_INQUEUE) != 0) n++;
        }
        return n;
    }

    static void Play(byte[] stereo, int bytes) {
        for (int i = 0; i < BUFFERS; i++) {
            IntPtr h = headers[i];
            if (((uint)Marshal.ReadInt32(h, FLAGS_OFFSET) & WHDR_INQUEUE) != 0) continue;
            Marshal.Copy(stereo, 0, Marshal.ReadIntPtr(h, 0), bytes);
            Marshal.WriteInt32(h, LENGTH_OFFSET, bytes);
            waveOutWrite(device, h, (uint)headerSize);
            return;
        }
    }

    static void CloseRing() {
        if (view != null) view.Dispose();
        if (file != null) file.Dispose();
        view = null;
        file = null;
    }

    static bool OpenRing(string[] pids, string user) {
        foreach (string pid in pids) {
            try {
                file = MemoryMappedFile.OpenExisting("discord-clips-audio-" + pid + "-" + user + ":voice", MemoryMappedFileRights.Read);
                view = file.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read);
                ringSize = view.ReadUInt32(8);
                cursor = view.ReadUInt32(4);
                if (ringSize != 0 && (long)ringSize + 12 <= view.Capacity && cursor < ringSize) return true;
            } catch (Exception) { }
            CloseRing();
        }
        return false;
    }

    static void Read(uint off, byte[] buf, int n) {
        off %= ringSize;
        int first = (int)Math.Min((uint)n, ringSize - off);
        view.ReadArray(12 + (long)off, buf, 0, first);
        if (first < n) view.ReadArray(12, buf, first, n - first);
    }

    static int Main(string[] args) {
        if (args.Length > 0 && args[0] == "--detach") return Detach(args);
        if (args.Length < 2) return 1;
        string[] pids = args[0].Split(',');
        string user = args[1];
        ulong check;
        if (!ulong.TryParse(user, out check)) return 1;
        int owner;
        if (!int.TryParse(Environment.GetEnvironmentVariable("VOICESTREAMS_OWNER"), out owner)) return 1;
        int startVolume;
        if (int.TryParse(Environment.GetEnvironmentVariable("VOICESTREAMS_VOLUME"), out startVolume)) volume = Math.Max(0, Math.Min(200, startVolume));
        if (!OpenDevice(Environment.GetEnvironmentVariable("VOICESTREAMS_DEVICE") ?? "")) return 2;

        Thread watch = new Thread(WatchOwner);
        watch.IsBackground = true;
        watch.Start(owner);
        string volumeFile = Environment.GetEnvironmentVariable("VOICESTREAMS_VOLUME_FILE");
        if (!string.IsNullOrEmpty(volumeFile)) {
            Thread volumes = new Thread(WatchVolume);
            volumes.IsBackground = true;
            volumes.Start(volumeFile);
        }
        // The plugin stops a player by this id when its person leaves
        try {
            Console.Out.WriteLine("P " + System.Diagnostics.Process.GetCurrentProcess().Id);
            Console.Out.Flush();
        } catch (Exception) { }

        byte[] head = new byte[24];
        byte[] pcm = new byte[BUFFER_BYTES];
        byte[] stereo = new byte[BUFFER_BYTES];
        byte[] cushion = new byte[7680]; // 40 ms of silence
        DateTime lastData = DateTime.UtcNow;
        DateTime lastReport = DateTime.UtcNow;
        int peak = -1; // -1 = no audio arrived at all
        while (true) {
            if (view == null && OpenRing(pids, user)) lastData = DateTime.UtcNow;
            uint write = view != null ? view.ReadUInt32(4) : cursor;
            int guard = 0;
            while (cursor != write && guard++ < 500) {
                Read(cursor, head, 24);
                uint len = BitConverter.ToUInt32(head, 0);
                uint ch = BitConverter.ToUInt32(head, 12);
                uint rate = BitConverter.ToUInt32(head, 16);
                uint size = BitConverter.ToUInt32(head, 20);
                if (len != size + 20 || ch < 1 || ch > 2 || size * (3 - ch) > BUFFER_BYTES || size % (2 * ch) != 0) {
                    // Not a frame (we were lapped, or the ring was reset): start again at the newest
                    cursor = write;
                    break;
                }
                Read(cursor + 24, pcm, (int)size);
                cursor = (cursor + 4 + len) % ringSize;
                lastData = DateTime.UtcNow;
                if (rate != 48000) continue;
                if (peak < 0) peak = 0;
                for (int i = 0; i + 1 < (int)size; i += 2) {
                    int s = Math.Abs((int)(short)(pcm[i] | (pcm[i + 1] << 8)));
                    if (s > peak) peak = s;
                }
                // After the peak, so the plugin still sees sound at volume 0
                int gain = volume;
                if (gain != 100) {
                    for (int i = 0; i + 1 < (int)size; i += 2) {
                        int s = (short)(pcm[i] | (pcm[i + 1] << 8)) * gain / 100;
                        s = Math.Max(-32768, Math.Min(32767, s));
                        pcm[i] = (byte)s;
                        pcm[i + 1] = (byte)(s >> 8);
                    }
                }

                int bytes = (int)size;
                byte[] play = pcm;
                if (ch == 1) {
                    for (int i = 0; i + 1 < bytes; i += 2) {
                        stereo[i * 2] = pcm[i];
                        stereo[i * 2 + 1] = pcm[i + 1];
                        stereo[i * 2 + 2] = pcm[i];
                        stereo[i * 2 + 3] = pcm[i + 1];
                    }
                    bytes *= 2;
                    play = stereo;
                }
                int queued = Queued();
                // Ran dry: put a little silence first so the next late frame doesn't click
                if (queued == 0) Play(cushion, cushion.Length);
                // Over 250 ms behind: skip this frame to catch up
                if (queued < 25) Play(play, bytes);
            }
            // A stopped stream may have been replaced by a new one with the same name
            if (view != null && (DateTime.UtcNow - lastData).TotalSeconds > 2) CloseRing();
            // Twice a second, tell the plugin how loud the stream was (0 = silence, -1 = no stream)
            if ((DateTime.UtcNow - lastReport).TotalMilliseconds >= 500) {
                lastReport = DateTime.UtcNow;
                try {
                    Console.Out.WriteLine("L " + peak);
                    Console.Out.WriteLine("A " + (RecorderMoving(pids) ? 1 : 0));
                    Console.Out.Flush();
                } catch (Exception) { }
                peak = -1;
            }
            Thread.Sleep(view != null ? 3 : 250);
        }
    }
}
`;
