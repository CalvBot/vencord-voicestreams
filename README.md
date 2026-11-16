# VoiceStreams

A Vencord plugin for Windows that plays each person in your Discord call from their own app, so
they get their own entry in the volume mixer and can be recorded separately.

![Six people in a call, each with their own discord-<username>-<userId>.exe and its own audio track](docs/showcase.png)

## Setup

1. Install [Vencord](https://vencord.dev/download/) if you don't have it.
2. Quit Discord fully, then extract `VoiceStreams.zip` from the
   [latest release](https://github.com/CalvBot/vencord-voicestreams/releases/latest) into
   `%APPDATA%\Vencord\dist`, replacing the files there.
3. Enable **VoiceStreams** in Vencord's plugin settings.

Vencord's installer (Repair) puts plain Vencord back.

People with "Allow Clips" off run from `%LOCALAPPDATA%\VoiceStreams\clips-off\`, everyone else from
`clips-on\`, so your recorder can skip them.

Uses undocumented Discord internals, so a Discord update can break it.
