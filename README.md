# Live Line (VSCodium extension)

Shows which line of your Python / MicroPython (ESP32) code is running right now, and marks the line where it crashed in red along with the exact code that failed.

## Features

- **Running line highlight**: Soft background highlight (`editor.lineHighlightBackground` by default) + play arrow in the gutter while a line is executing.
- **Error highlight**: When a script crashes with an uncaught exception (or syntax error), the failing line is highlighted in red, the exact expression/symbol that broke is underlined and highlighted, and the error message is shown inline at the end of the line (with the full traceback on hover).
- **Dismiss on edit**: Moving the cursor or clicking around leaves the red error mark in place; as soon as you type/edit in that file, the red mark disappears.
- **Works in both**:
  - **VSCodium**: Press `F5` (or the `▶` Run button in the top-right, or run `python file.py` in the integrated terminal). Press `Shift+F5` (or the `■` Stop button) to stop a running script.
  - **ESP32 Camera IDE (VSCodium)**: Works automatically with `Run on ESP32` (`F5` / `▶`) and `Stop script on ESP32` (`Shift+F5` / `■`).

## Installing / Updating

```bash
./install.sh
```

Then reload VSCodium (`Ctrl+Shift+P` -> **Developer: Reload Window**).

## License

MIT. Made with the help of AI (Claude Code).
