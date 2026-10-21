# Changelog

## Unreleased

- Bypass signon and the user ID follow the settings page on the next connect of an open session (before, a session kept the values it was opened with).
- Settings: User ID and Set Password… are always shown under IBM i signon information; Bypass signon only decides whether they are typed in automatically.
- Enhanced UI: the host's underline and column separators are drawn everywhere except inside boxed input fields. Before, Enhanced mode dropped them on all text, so underlined column headings (DSPATR(UL)) and protected input fields lost their underline.

## 0.1.2

- SEU syntax colouring for RPG/RPGLE (fixed, free, fully free, embedded SQL), CL, DDS and DB2 SQL. The language comes from the source file name (QRPGLESRC, QCLLESRC, QDDSSRC, QSQLSRC ...) or the code itself; colours follow the 5250 colour settings, and the host's own colours (errors, reverse image) are left alone.
- Connection overlay: a card over the dimmed screen while connecting (Cancel) and when the connection is lost, with the reason, a live reconnect countdown, Reconnect now / Stop (Enter / Esc). Keys no longer vanish silently while disconnected.
- Plain-language connection errors (refused, host not found, no answer, unreachable, reset, TLS certificate / wrong port).
- Dropped networks are noticed sooner (TCP keepalive after 15 s idle).
- Enhanced UI: input fields longer than 60 characters (command lines, QSH, long comment fields) get a thin underline instead of a box; SEU source lines stay plain.
- Type-ahead: keys pressed while the keyboard is locked (X SYSTEM) are kept and replayed when the host unlocks it, up to the next Enter or function key; an error message or Reset discards the rest. The status line shows how many are waiting. Settings → Behavior → Type-ahead (on by default).
- Enhanced UI: field boxes end where the host ends the field's underline (a plain attribute inside the field), as ACS shows it — e.g. database record editors that define long input fields but underline only the data length.
- New icon.

## 0.1.1

- Settings: Add Connection works again (the new entry was hidden because it had no host yet).
- Ctrl+V and Shift+Insert paste into the terminal (the clipboard is read by the extension host).
- 10-key: keypad + and - are Field+ / Field- again instead of typing the character (key mappings now take precedence over typing).
- Watermark: Custom position (free horizontal/vertical placement in percent) and Tile (repeats the mark over the screen, with an adjustable gap); edge distance slider for the corner positions.
- No more "Webview is disposed" errors when a terminal or the settings page is closed while a session is still reporting.

## 0.1.0

- Demo sessions: tilted watermark, coloured frame, [DEMO] tab prefix and status pill; Duplicate Connection.
- Enhanced UI text highlight mode (gradient boxes with contrasting text) and a glow strength slider.

- Enhanced UI mode: gradient background, field outlines, active-field glow, text glow, function keys as buttons, scanlines, padding; all configurable.
- ACS appearance parity: OIA and other colours with import/export, rule line, blinking-text modes, crisp/smooth text, bold font, image watermark with padding, hotspots (PF/FP/F/number/URL, 3-D buttons, Enter at click), paste tab handling and copy options, window title composition with session letters, New Tab (same session), Disconnect All.
- Settings page reorganized into Connection, Screen, Appearance, Edit, Hotspots, Tabs, Keyboard, Preferences with live previews.

- Terminal tab with canvas renderer, auto-fit and zoom, OIA status line.
- TN5250 engine: telnet negotiation (BINARY, EOR, TERMINAL-TYPE, NEW-ENVIRON),
  GDS records, EBCDIC code pages 37/273/500/1140-1149, Write To Display with all
  orders, Clear Unit / Alternate, Read commands, Roll, Write Error Code,
  Save/Restore Screen, Query reply.
- Keyboard: typing with shift/edit validation, insert mode, Field Exit / + / -,
  Dup, Erase EOF / Input, Tab / Backtab, cursor keys, AID keys F1-F24, Attn,
  SysReq, Reset, operator error codes.
- Commands: New Session, Disconnect, Reconnect, Demo Screen, Key Debug Overlay.
- Settings page modeled on ACS: profiles (defaults + saved sessions), connection, TLS, screen, font, preferences, colour mapping, keyboard assignment.
- Side bar with saved sessions, Add Tab, status bar item, session trace export.
- Rectangle selection and copy, hotspots, mouse wheel paging, watermark, cursor styles, auto-reconnect, inactivity timeout.
