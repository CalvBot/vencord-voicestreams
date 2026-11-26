# VoiceStreams

A Vencord plugin for Windows. Each person in your Discord call plays from their own app, so you
can set their volume in the Windows mixer or record them separately.

![Six people in a call, each with their own discord-<username>-<userId>.exe and its own audio track](docs/showcase.png)

## Install

Get it with the
[Vencord Plugin Installer](https://github.com/CalvBot/vencord-plugin-installer/releases/latest).

## Good to know

- People who turned off "Allow Clips" run from `%LOCALAPPDATA%\VoiceStreams\clips-off\`, everyone
  else from `clips-on\`, so a recorder can leave them out.
- It uses undocumented parts of Discord, so a Discord update can break it.
