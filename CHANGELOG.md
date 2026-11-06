# Changelog

## 0.2.1 - unreleased

- Bypass sign-on guards QMAXSIGN: sessions for the same user profile and host sign on one at a time, and after the host refuses one the others do not send the password at all (a log line and one warning say so). Saving the settings, setting the password or reconnecting by hand tries again. Five tabs reloaded with a wrong code page, or a stale saved password on an auto-reconnect loop, no longer disable the profile. The session log names the code page in use on every connect.
- Fixed: Save Screen left the GUI windows out of the image, so a screen restored after a called program (Restore Screen) came back with the window borders as raw blue cells instead of windows. The image now carries every Create Window with the cells it shows, in order, and Remove GUI Window still uncovers the screen beneath.

## 0.2.0 - 2026-11-04

- Fixed: a password with characters that differ between EBCDIC code pages (`!`, `@`, `#`, `[`, `]` ...) failed with CPF1120 when Host Code Page did not match the host's CCSID, and nothing pointed at the cause. After such a failed sign-on the emulator shows a one-time hint naming the characters and the code page in use (Output log too, never the password); the Host Code Page and Bypass signon help texts and a new README Troubleshooting section explain it; the keyboard type sent with the workstation name now follows the code page (#5, reported by ZodandSons).
- Security review (traces, sign-on, secrets, TLS): a saved session trace blanks what was typed into non-display fields (passwords), keeping the lengths. Bypass sign-on types the password only into a non-display field, on the first screens after connect, and logs when it skips a screen. Saved passwords are keyed by user profile and host (`USER@host`, as in the desktop app); a password saved by an earlier version under the profile name moves over the first time it is used, and no profile ever falls back to another user's or the host-only key (unnamed profiles enter their password once more). Removing a profile removes its secrets. Session profiles, connection settings, the PC command policy and TLS trust are application-scoped: a workspace `.vscode/settings.json` can no longer change them (untrusted workspaces are supported, with the font and watermark file settings restricted). Bypass sign-on over plain telnet warns on the settings page and in the log. Non-display cells leave the engine as blanks, so the webview never holds them.
- TLS: the host certificate is checked after the handshake against the system roots plus an optional CA file (`tlsCaFile`, e.g. an IBM i DCM local CA); a refused certificate shows its SHA-256 fingerprint and "Trust this certificate" pins it for that session (`tlsPinnedCertificate`); TLS 1.2 is the minimum; switching Protocol to TLS moves port 23 to 992 (and back). The certificate error now offers those before "turn verification off".
- NEW-ENVIRON: KBDTYPE and CHARSET follow the host code page (IBM's keyboard type table and the CDRA character set ids) instead of USB/697 for every code page; a new Keyboard type setting overrides the keyboard for countries that share a code page; unknown code pages send DEVNAME only, as RFC 4777 prescribes.
- Fixed: a Write Structured Field carrying more than one structured field was scanned byte by byte after the first one, so a X'04' inside the second read as a command.
- Settings page: Save and Assign no longer jump to the top (the page updates in place, or restores the scroll position when it must rebuild); confirmations and notices are one corner toast with a queue; field validation stays on the field.
- Docs and comments: DESIGN.md describes the 0.2.0 layout, settings keys and security; stale references to tooling that is not in the repository are gone; the PC commands setting says plainly what "Run everything" allows.
- Fixed: selection field choices were laid out two columns to the right of where the host puts them (the field address is the text's leading attribute; the check box / radio button cells sit to its left), so pull-down text ran past the window and lost its last letters.
- Fixed: a host error message written with Write Error Code stayed on the message line after the host repainted, and the read that follows such a message homed the cursor to the first field; now the row it covered comes back with the next write and the cursor stays where the error happened. A cursor the host places inside a selection field lands on its first choice, so the arrow keys work the field at once. I/O fields (DDS data type I) refuse keyboard data with error 0004.
- Fixed: System Request (Shift+Esc), Attention (Esc) and Test Request were swallowed while the host had the keyboard locked (X SYSTEM), so a running program or a long batch could not be interrupted. They now go to the host at any time, as on a real display.
- Entry field FCWs of the enhanced interface: continued entry fields (DDS CNTFLD) are edited as one field across their segments (typing, Insert, Delete, Backspace, Erase EOF, Field Exit, Dup) and go back to the host as one field; word wrap fields (WRDWRAP) keep words whole across lines and segments and drop their padding on the read; cursor progression (FLDCSRPRG) sends Tab and a filled field to the numbered field and Backtab back; highlighted entry fields (ENTFLDATR) change their attribute while the cursor is in them and can hide the cursor.
- Selection fields (enhanced 5250 Define Selection Field): menu bars with their separator line, pull-downs, single choice fields and lists (radio buttons), multiple choice fields and lists (check boxes) and push buttons, laid out as the host defines them. Tab enters a field at its first choice, the arrows move the selection cursor between choices (Roll keys at the edges the host marks), Space and / select, Delete deselects, a typed mnemonic letter or number picks its choice, a click selects, and auto-enter / auto-select / per-choice AIDs send the field at once (push buttons). The host receives the choice number or one byte per choice, plus the scroll increment of a list's own scroll bar, in the format of the 5494 reference. The Enhanced style draws radio buttons, check boxes, push button frames, the selection cursor and the mnemonic underline; the Classic style shows the characters a character display shows.
- Programmable Mouse Buttons (enhanced 5250): pointer events the host programmed (left, right or middle button pressed, released or double-clicked, with or without Shift) send the host's AID with the cursor at the pointer, as single events or two-event sequences; queued single events wait for the keyboard to unlock. The browser's context menu stays away from a right button the host uses.
- Write Data fills an entry field at the write address and nulls the rest; a Create Window with the restrict-cursor flag keeps Tab, the arrows and clicks inside the window until Unrestricted Window Cursor Movement.
- Scroll bars (enhanced 5250): a subfile compiled with SFLEND(*SCRBAR), or a selection list, gets the scroll bar the host defines (Define Scroll Bar Field), drawn as a modern bar with arrows and a proportional thumb in the columns the host reserves for it. The arrows scroll one row, a click on the track a page, and the thumb can be dragged; the host receives the Roll key and the scroll increment at the bar's address, as it does from ACS, so the subfile repositions itself. Horizontal bars work the same way with Roll Left / Roll Right. Remove GUI Scroll Bar, Remove All GUI Constructs, Clear Unit, Restore and a new format take the bar away.
- Setting `tn5250.display.subfileScrollBar` (off by default): a scroll bar beside every subfile whose last row ends in More..., Bottom or +, even when the display file does not ask for one. It lives in a gutter right of the text (no cell is covered) and its clicks send Page Up / Page Down; the thumb only shows whether there is more.
- GUI windows carry their title and footer (Create Window title/footer minor structure): the Enhanced style draws the window as a frame with a shadow and the title on the top edge instead of the border characters; the Classic style shows the title in the border like a character display.
- PC commands from the host (STRPCCMD / PC Organizer): a host program that runs `STRPCCMD PCCMD('START http://...')` used to leave the terminal on the host's "Required PC program (PCO.EXE) is not active" screen. The terminal now recognises the request, opens http(s) links in the default browser and presses Enter for the host, so the program carries on without a flash of that screen. Other commands ask first (Run / Cancel) and run through the shell; PAUSE(*YES) waits for the command to finish. Setting `tn5250.behavior.pcCommands`: `links` (default), `ask`, `all`, `off`.
- The screen no longer resizes itself back and forth when a side panel narrows the editor by just the wrong amount (Enhanced style, or a zoomed-in screen): the fitted screen never shows scrollbars, and the size is measured so scrollbars cannot change it. A zoomed-in screen scrolls from its top-left corner instead of being cut off on the left.

## 0.1.8 - 2026-11-04

- The session icons of the side bar (grey, and green while connected) were missing from the packaged extension since 0.1.6: the packaging whitelist did not include them. No other change.

## 0.1.7 - 2026-11-03

- README only: screenshots, corrected keyboard and status sections, working Marketplace badges. No code changes since 0.1.6, which was withdrawn from the Marketplace because its page could not be updated in place.

## 0.1.6 - 2026-11-03

- Keyboard settings page: a visual keyboard (main block with an F13-F24 row, navigation keys and a keypad with tall + and Enter) above the search. The search boxes have a clear (x) that stays while there is text. Keys light up as you press them, a green dot marks the keys that have a function (hover lists them) and a click on a key lists the functions bound to it. While Assign is active, typing a key or combination assigns it at once as before; clicking the keys on the picture builds the combination in the key bar underneath, where Save keybind assigns it and Cancel leaves Assign (keys typed while something is latched add to the picture; the Esc cap clears it). A letter, digit or symbol without Ctrl or Alt is refused, since the terminal types it. The key bar also reports what just happened (assigned, moved from another function with Undo, unassigned, restored, cancelled). The picture wraps and then shrinks with the page instead of squashing the keys.
- Keyboard settings page: the "No key for ..." warning looks at the key ACS actually gives the function (Shift+F1 for F13), so unassigning it brings up Restore even though the layout also knows a physical F13 key.
- Sessions side bar: connections with an open tab come first, with a green glowing icon while connected and a badge with the connected count; each expands to its open tabs (click shows the tab; Close and Reconnect on the row). A click on a connected session shows its most recent tab; the plug icon still opens another. Tabs for hosts not saved as connections appear under "Unsaved connections". The row's hover icons no longer stick after a click.
- History view in the TN5250 side bar: every connection is recorded with host, session, tab title, workstation name, the user profile typed on the sign-on screen (or the bypass sign-on user), start, end, duration and how it ended. Click twice (or the info icon) for the details, Connect again, Copy device name and Remove; Clear History in the view title. Settings `tn5250.history.enabled` and `tn5250.history.limit`. The job number is not in the 5250 data stream, so it is not recorded. An entry left open by a crash or a closed window is ended at the last minute the tab was seen connected; a workstation name the host refuses (next one tried) stays one entry, and the tab title shows the name the host accepted. Connect again is offered only for entries that have ended.

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
