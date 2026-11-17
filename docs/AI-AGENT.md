# TN5250 for AI agents: setup and use

This guide takes you from nothing to an AI agent (Claude Code) that drives 5250 sessions on your IBM i while you watch it work from VS Code. It covers both halves:

- **tn5250-tui**, the console terminal, which has the MCP server the agent talks to (`tn5250-tui mcp`) and the viewer that shows what the agent is doing (`tn5250-tui attach`). Repository: <https://github.com/DerKyberTakt/tn5250-tui>.
- **TN5250 Terminal for VS Code**, this extension, which finds the running servers, lists their sessions, opens any of them read-only in a terminal, writes the agent's `.mcp.json`, and can enroll one of your connections as the agent's sign-on.

The agent never gets your password through the model: credentials live in the console terminal's sites file (sealed into the OS secret store on first start) and the MCP server signs on with them. The agent sees screens and sends keys, nothing else.

## What you need

| | |
|---|---|
| An IBM i you can reach on port 23 (or 992 with TLS) | Any release that runs TN5250; tested on 7.5 and on PUB400.COM. |
| A user profile for the agent | Its own profile is best: the host then logs the agent's work under that name and the profile's authority is the fence. Your own profile works too (see Enrolling yourself). |
| tn5250-tui 0.2.0 or newer | The first release with `mcp` and `attach`. |
| TN5250 Terminal 0.2.7 or newer | The first release with the AI Agent settings page. |
| Claude Code | Or any MCP client that can start a stdio server from `.mcp.json`. |

## 1. Install tn5250-tui

Windows (PowerShell 5.1 or newer):

```powershell
iwr -useb https://raw.githubusercontent.com/DerKyberTakt/tn5250-tui/main/install.ps1 | iex
```

Installs into `%LOCALAPPDATA%\Programs\tn5250-tui` and adds that folder to your user PATH. Open a new terminal afterwards so PATH is fresh.

Linux and macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/DerKyberTakt/tn5250-tui/main/install.sh | sh
```

Installs into `~/.local/bin` after checking the release's `SHA256SUMS`. Arch Linux: `yay -S tn5250-tui-bin`.

Check it:

```
tn5250-tui --version
```

Without an install script, download the archive for your platform from the [releases page](https://github.com/DerKyberTakt/tn5250-tui/releases) (`tn5250-tui_<ver>_windows_amd64.zip`, `_linux_amd64.tar.gz`, `_darwin_arm64.tar.gz`, ...), unpack it and put `tn5250-tui` on PATH, or point the extension at it (step 3).

## 2. Give the agent a sign-on

The agent signs on through a **site**: an entry in tn5250-tui's sites file with the host, the user and the password. The site is called `agent` unless you change `tn5250.agent.site`.

**Option A, its own user profile (recommended).** On the host, create a profile for the agent with the authority it should have and nothing more, for example:

```
CRTUSRPRF USRPRF(AGENT1) PASSWORD(...) INLMNU(*SIGNOFF) LMTCPB(*YES) TEXT('AI agent')
```

(`LMTCPB(*YES)` keeps it off the command line; loosen it when the agent is meant to run commands.) Then save the site in tn5250-tui: start `tn5250-tui`, type `:sites`, add a site named `agent` with the host, port, the agent's user and password, and bypass sign-on on. The password goes into the OS secret store (Credential Manager, Keychain, Secret Service), not into the file.

**Option B, enrolling yourself.** When the agent cannot have a profile of its own, the extension writes one of *your* connections, with your user and password, as the agent's site: **TN5250: Enroll User for AI Agent** (Command Palette, the Agent Sessions view's title, or the AI Agent settings page). It asks first and names the file it writes to, because your password leaves the VS Code secret store for the sites file; the next start of tn5250-tui or its MCP server seals it into the OS secret store. Everything the agent does is then logged under your profile. Enrolling again on an enrolled site asks to **Replace** the current enrollment and names it; a server that is already running keeps the old sign-on until it restarts. **TN5250: Remove Agent Enrollment** takes the site out again.

Where the sites file is: `%APPDATA%\tn5250-tui\sites.json` on Windows, `~/.config/tn5250-tui/sites.json` elsewhere (`TN5250_TUI_CONFIG` overrides it).

## 3. Turn the feature on in VS Code

Open the TN5250 Settings page (the gear in the TN5250 side bar, or **TN5250: Open Settings**) and go to **AI Agent**:

| Setting | What it does |
|---|---|
| **Agent Sessions view** (`tn5250.agent.enabled`) | Shows the Agent Sessions view in the TN5250 side bar. Off by default. |
| **tn5250-tui** (`tn5250.agent.binary`) | Path of the console terminal. Empty = found on PATH or in the installer's folder; Browse picks one. The page says which one was found. |
| **Site** (`tn5250.agent.site`) | The site the agent signs on with; `agent` by default. The page says who is enrolled under that name. |
| **Read-only server** (`tn5250.agent.readOnly`) | Starts the server with `--read-only`: typed text that starts a command that changes things (`DLT*`, `CLR*`, `CHG*`, `CRT*`, `RMV*`, `UPD*`, `SBMJOB`, `CALL`, `RUNSQL`, ...) is refused. On by default; turn it off only for an agent that is meant to change things. |

These are application-wide settings with their own **Save** button on that page.

## 4. Set up Claude Code

In the workspace the agent will work in, run **TN5250: Set Up Claude Code** (Command Palette, the Agent Sessions view's gear, or the AI Agent page). It writes, or merges into, the workspace's `.mcp.json`:

```json
{
  "mcpServers": {
    "tn5250": {
      "command": "C:\\Users\\you\\AppData\\Local\\Programs\\tn5250-tui\\tn5250-tui.exe",
      "args": ["mcp", "--site", "agent", "--read-only"]
    }
  }
}
```

Other settings in the file are kept. Start Claude Code in that workspace (or `/mcp` to reconnect in a session that is already open); it lists the `tn5250` server with its tools. A Claude Code skill that teaches the agent 5250 habits (read the screen, use labels, press reset on an error) is in the tn5250-tui repository under [`skill/tn5250-agent`](https://github.com/DerKyberTakt/tn5250-tui/tree/main/skill/tn5250-agent); copy it into the workspace's `.claude/skills/`.

Other MCP clients start the same command: `tn5250-tui mcp --site agent --read-only` on stdin/stdout.

## 5. Let the agent work, and watch it

Ask the agent for something on the host, for example:

> Sign on to the agent site, open WRKACTJOB and tell me which jobs in QBATCH are waiting on a message.

The agent calls `connect` (the site's bypass sign-on takes it past the Sign On screen), then `screen`, `press`, `type`, `fill`, `wait` and `find` as it goes, and `disconnect` when done. Every key waits for the host: the keyboard unlocked and the screen quiet. Up to the server's session limit, several sessions can be open at once.

While it works, the **Agent Sessions** view shows every running server and its sessions:

- The view's title says how many agent sessions are connected. A server with a connected session, and the session itself, carry the green session icon; disconnected ones are grey.
- A click on a session opens it, live and read-only, in a VS Code terminal (`tn5250-tui attach`). The row's buttons put that terminal in the editor area (a tab you can drag out) or in a window of its own, so the agent's screen can sit next to your work.
- A server whose process has ended disappears on its own. One that still runs but does not answer shows as *not answering* with a **Forget** button; **Clean Up Agent Servers** (view title) forgets all of them at once.

From any terminal, `tn5250-tui attach --list` prints the running servers and their sessions, and `tn5250-tui attach s2` watches one (Tab cycles sessions, `r` reloads, `q` quits).

## 6. Audit and traces

- `--audit FILE` on the server's command line appends one JSON line per agent action: which tool, which session, what was typed (passwords never; non-display fields are blanked), and the result. Add it to the `args` in `.mcp.json` when you want a record.
- The `trace` tool returns the session's data-stream trace (masked like the terminal's traces), `trace` with `from_start` the negotiation too; `dump` the raw screen. The agent can hand these to you when something on the host looks wrong.
- The server listens on 127.0.0.1 only, on a random port, with a token in `<sites dir>/agent/<pid>.json` (mode 0600); `--no-listen` turns the listener off, and the view then shows nothing for that server.

## Troubleshooting

| What you see | What it means |
|---|---|
| The AI Agent page says tn5250-tui was not found | It is not on PATH. Open a new terminal after installing, or set `tn5250.agent.binary` with Browse. |
| Claude Code lists no `tn5250` server | `.mcp.json` is in another folder, or Claude Code was started before it was written: `/mcp` reconnects. |
| `connect` fails with *no saved site "agent"* | The site is not in tn5250-tui's sites file: step 2. With `TN5250_TUI_CONFIG` set, the extension and tn5250-tui must both see it. |
| `connect` says the password is not in the secret store any more | The OS secret store lost it (a new machine, a cleared Credential Manager). Enter it again in `:sites`, or re-enroll. |
| The agent signs on as the old user after a re-enrollment | A server started before the change keeps the sign-on it loaded; `/mcp` reconnect in Claude Code restarts it. From tn5250-tui 0.2.1 the server re-reads the sites file on every connect that names a site. |
| Sign On screen shows *CPF1120 User ... does not exist* or *password not correct* | The site's user or password is wrong for that host, or the host's code page turned `!`, `@`, `#`, `[`, `]` in the password into other characters: set the site's code page to the host's CCSID (037 for US hosts) and reset the password once. |
| A session shows *host busy* for long | The host has the keyboard locked (a long-running command); `wait` with a longer timeout, or `press reset` after an error. |
| *not answering* in the Agent Sessions view | The server's process is gone or hung. Forget removes the entry; a process that is gone is dropped automatically. |

## Where things are

| | Windows | Linux / macOS |
|---|---|---|
| tn5250-tui | `%LOCALAPPDATA%\Programs\tn5250-tui\tn5250-tui.exe` | `~/.local/bin/tn5250-tui` |
| Sites file | `%APPDATA%\tn5250-tui\sites.json` | `~/.config/tn5250-tui/sites.json` |
| Server tokens | `%APPDATA%\tn5250-tui\agent\<pid>.json` | `~/.config/tn5250-tui/agent/<pid>.json` |
| Passwords | Credential Manager | Keychain / Secret Service (an encrypted file with `secret.key` when there is no keyring) |
| Workspace MCP config | `.mcp.json` in the workspace root | same |
