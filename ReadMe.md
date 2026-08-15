# Electronic Rack

ESP32 firmware + web UI for a NeoPixel-backed component organizer. Default layout is **6×6 = 36 bins** (change to 6×5 or anything else in Setup). Search a part, stocked bins rise to the top, the matching compartment lights up, and +/− is the whole check-in / check-out flow.

## What you get

- Station Wi-Fi (SSID/password in `include/secrets.h`) and `http://rack.local:8080`
- Fallback AP `RACK-xxxxxxxx` if station join fails, so the UI is never bricked
- Fast local catalog: every common resistor / capacitor / inductor value generated in the browser, plus a curated bench list (solder, flux, Pis, ESPs, passives kits, tools)
- Live search against public JLCPCB / LCSC indexes when you type a manufacturer part
- Persistent inventory and settings on LittleFS
- Expandable grid, LED pin / count / color order, wiring math, per-bin LED overrides
- Startup + idle animations, locate pulse, calibration corners, walk, tap-to-map
- Backup / restore JSON from the UI

Wi-Fi is the only compile-time setting. Everything else is in the web UI.

## Hardware

- ESP32 DevKit
- WS2812 / WS2812B / SK6812 **RGB** strip, one LED behind each bin
- **GPIO 13** = data (change in Setup; if you change it, power-cycle after save)
- Common ground between ESP32 and the 5 V LED supply
- 36 LEDs at full white can exceed 2 A — use a dedicated 5 V supply and keep brightness modest

Typical strip: DIN → GPIO 13 with a 330–470 Ω resistor, 1000 µF across the strip 5 V rail.

## Flash

1. Copy credentials:

```bash
cp include/secrets.example.h include/secrets.h
```

2. Edit `WIFI_SSID` / `WIFI_PASS`.

3. Install [PlatformIO](https://platformio.org/) and run:

```bash
pio run -t upload
pio run -t uploadfs
pio device monitor
```

The filesystem image is the UI (`data/`). Re-upload it whenever you change HTML/CSS/JS.

Then open `http://rack.local:8080` or `http://<ip>:8080`.

## First-run calibration

1. **Setup → LED wiring**
2. Set LED count, then **Light corners**
   - A1 = red
   - last column on row 1 = green
   - last row, column A = blue
   - opposite corner = white
3. Flip *LED 0 corner*, *Then run*, and *Serpentine* until the four corners match the physical strip. That is the whole automatic map.
4. If a few bins are still wrong, **Tap-to-map**: LED N lights, tap that bin on the Grid tab, repeat.
5. **Walk bins** to watch every compartment in label order.

Changes save immediately.

## Daily use

- Type `10k`, `100n`, `4k7 0603`, `flux`, `ESP32`, or an LCSC code
- Stocked hits are first, with bin label and count
- Tap a row: that bin pulses cyan
- + / − (hold to repeat) is put-in / take-out
- New part: first empty bin is pre-selected — change bin on the mini-grid if needed, set qty, done
- Grid tab is the physical map; tap an empty bin then search to fill it

Keyboard: `/` search, arrows, Enter, `+` / `-`, Esc.

## Expand the rack

Setup → raise **Rows** / **Columns** and **LED count**. New bins are empty. Inventory in old labels stays put. You can run multiple strips as one logical chain (offset + count).

## Local UI without hardware

```bash
python3 scripts/generate_named_parts.py
python3 scripts/dev_server.py
```

Open `http://127.0.0.1:8080/`. LED calls print to the terminal.

## Project layout

```
include/     public headers + secrets
src/         firmware modules (storage, rack map, inventory, LEDs, Wi-Fi, HTTP, catalog proxy)
data/        LittleFS web UI
scripts/     named-part generator, desktop API, PlatformIO pre-script
```

Firmware is split so the LED engine, inventory, and HTTP API can change independently. The browser owns search ranking so the ESP32 stays snappy.

## API (short)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/status` | IP, heap, firmware |
| GET/PUT | `/api/config` | Grid, wiring, LEDs, UI flags |
| GET/PUT | `/api/inventory` | Full inventory |
| POST | `/api/stock/place` | Put a part in a bin |
| POST | `/api/stock/adjust` | `{ cell, delta }` |
| POST | `/api/locate` | Pulse a bin |
| POST | `/api/leds` | `idle` / `corners` / `walk` / `identify` / `startup` / `off` |
| GET | `/api/catalog/remote?q=` | JLCPCB / LCSC proxy |
| GET/POST | `/api/backup` `/api/restore` | Snapshot |

WebSocket `/ws` pushes `status`, `dirty`, and walk highlights.
