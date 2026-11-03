# Changelog

## Unreleased

- Keyboard settings page: a visual keyboard (main block, navigation keys and keypad) above the search. Keys light up as you press them, a green dot marks the keys that have a function (hover lists them) and a click on a key lists the functions bound to it. While Assign is active, typing a key or combination assigns it at once as before; clicking the keys on the picture builds the combination in the key bar underneath, where Save keybind assigns it and Cancel leaves Assign (keys typed while something is latched add to the picture; the Esc cap clears it). A letter, digit or symbol without Ctrl or Alt is refused, since the terminal types it. The key bar also reports what just happened (assigned, moved from another function with Undo, unassigned, restored, cancelled). The picture wraps and then shrinks with the page instead of squashing the keys.
- Keyboard settings page: the "No key for ..." warning looks at the key ACS actually gives the function (Shift+F1 for F13), so unassigning it brings up Restore even though the layout also knows a physical F13 key.
- Sessions side bar: connections with an open tab come first, with a green glowing icon while connected and a badge with the connected count; each expands to its open tabs (click shows the tab; Close and Reconnect on the row). A click on a connected session shows its most recent tab; the plug icon still opens another. Tabs for hosts not saved as connections appear under "Unsaved connections". The row's hover icons no longer stick after a click.
- History view in the TN5250 side bar: every connection is recorded with host, session, tab title, workstation name, the user profile typed on the sign-on screen (or the bypass sign-on user), start, end, duration and how it ended. Click twice (or the info icon) for the details, Connect again, Copy device name and Remove; Clear History in the view title. Settings `tn5250.history.enabled` and `tn5250.history.limit`. The job number is not in the 5250 data stream, so it is not recorded. An entry left open by a crash or a closed window is ended at the last minute the tab was seen connected.

## 0.1.5 - 2026-11-03

- Settings that only take effect on a new connection (host, port, protocol, workstation ID, screen size, code page, timeouts, type-ahead, auto-reconnect, alarm) are marked on the settings page. Saving one of them while a terminal that uses it is open now asks: **Save & Reload** reconnects those tabs with the new values at once, **Save & Close** saves only. Before, a screen-size change needed a new tab, and a Default change did not reach a tab whose saved session overrode that field.
- Keyboard settings page: Assign takes key combinations with Ctrl (Ctrl+Shift+E), and a modifier on its own (Right Ctrl) when it is released; Esc cancels. A key taken from another function says so, with Undo; a function whose ACS key is gone (Reset without Left Ctrl) is flagged at the top with a Restore link, and its ACS default is shown greyed in the list. Import and Reset moved to the top of the page with explanations; the .kmp picker opens in the ACS keyboard-map folder (Documents\IBM\iAccessClient\Emulator) and the import lands in the form, saved with the rest.
- Alt+Left / Alt+Right (Tab Word / Backtab Word) no longer leave the keyboard focus in VS Code's menu bar when Alt is released: a bare Alt press is the terminal's now, as a bound Control key is.
- Key combinations with Ctrl, Alt or Meta that the keymap does not use (Ctrl+Shift+B, Ctrl+J, Ctrl+1 ...) go to VS Code instead of being swallowed; the fixed list of editor shortcuts is gone. The key overlay names bare modifiers by their key (ShiftLeft), not "Ctrl+Shift+Shift".
- Double-click on a word inside an input field selects the word (clipped to the field); a double-click on a blank inside an input field selects the field, as before; a blank elsewhere selects nothing.
- Save & Reload: the dialog lists the open tabs it would reload by title, the second button is Apply & Continue, and the settings page itself warns above the Save button which open tabs a connection change will not reach until they reload.
- Colours that the Enhanced screen style does not use (Screen background, Active field, OIA background) are greyed out while that style is on, with the reason printed beside the row; the Enhanced UI colours are greyed out while the style is Classic.
- Keyboard page: the search box, Import and Reset share one line; a "No key for ..." warning can be ignored (setting `tn5250.keyboard.warningsIgnored`), and comes back when that function gets a key and loses it again, or when a .kmp is imported. The clear (x) of the search boxes is red.
- Keyboard: the ACS cursor and edit functions that were missing. Fast Cursor Up/Down/Left/Right (3 rows or columns per press, Ctrl+arrows), Tab Word / Backtab Word (Alt+Right / Alt+Left), Beginning of Field, Delete Word (Ctrl+Delete), Erase Field, Test Request (Ctrl+F12) and a Rule line on/off key (Ctrl+Home). Copy and Paste are now keymap actions (Ctrl+C / Ctrl+Insert, Ctrl+V / Shift+Insert as before), so Dup can be assigned to any key; it is unassigned by default, as in ACS. The `.kmp` import understands the standard ACS/HOD names for all of these (fastup, wordleft, bof, worddel, erasefld, test, field+, field-, erinp, rcdbacksp, instog, fieldexit, printps).

## 0.1.4 - 2026-11-02

- Right Ctrl = Enter and Left Ctrl = Reset work (the default ACS layout), and a Control key assigned on the Keyboard settings page fires. Before, a modifier pressed on its own was handed back to the editor before the keymap was consulted, so Right Ctrl did nothing. The key overlay (TN5250: Toggle Key Debug) now shows `ControlRight -> enter`.
- Enhanced 5250 interface: the terminal answers the host's Query as an enhanced-interface display, as ACS does. DDS windows then arrive as GUI windows: the border is drawn by the terminal, what a window covers is remembered and comes back when the program removes the window (Remove GUI Window, Remove All GUI Constructs, Save/Restore Partial Screen). Before, a window drawn by a prompt program stayed on a screen the program only repainted with PUTOVR (PO05Z2 F4 prompts), exactly as in Mocha.
- Back on a menu after F3/F12, the cursor is in the option field (the first input field) again, as in ACS. A format the host rewrites after Restore Screen (new Start of Header) no longer keeps the cursor where it was when the screen was saved, which left it one position in, or in the second field, and needed a Tab back.

## 0.1.3 - 2026-10-28

- Command attention keys (DDS CA03, CA12 ...) no longer send what was typed: the host's Start of Header command key bytes are honoured, so a program sees the same thing it sees from ACS (e.g. a 1 typed on a row and then F3 is discarded, not processed). Before, every function key returned the modified fields.
- After a window closes (F12 / Enter on a DDS WINDOW), the cursor lands in the first input field of the screen underneath instead of the top-left corner.
- A full field-exit-required field no longer loses its last character: Field Exit, Field +/- and Erase EOF keep it, Backspace removes it, and typing more reports 0020 until the cursor moves. Pasting a value that exactly fills a field no longer wipes the next field.
- End is End of Field (cursor after the last typed character), on the main keyboard and the keypad, as in ACS; Alt+End / Alt+keypad End erase input; Erase EOF moved to Ctrl+End. Imported .kmp files map `[eof]` to End of Field.
- Keyboard settings page: a search box narrows the key and function list; the global settings search finds keys and functions too.
- Settings: Copy connection, a new connection with all the settings of the selected one.
- Settings: the watermark preview shows the image (and the font preview the imported font) of the profile picked in the list, not only of the profile the page opened on; the position and offset sliders move it again.
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
