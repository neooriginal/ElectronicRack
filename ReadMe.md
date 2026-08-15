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
- GitHub Actions builds firmware on every commit and publishes a rolling `latest` release
- In-app OTA pulls `firmware.bin` + `littlefs.bin` from that release (`neooriginal/ElectronicRack`)

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

This USB flash is required **once** after the dual-OTA partition table change. Later updates install from **Setup → Firmware**.

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

## API

Full reference: **[docs/API.md](docs/API.md)** (also served on the device as `/api.md`).

Quick GET API — one URL, no body:

```bash
curl http://rack.local:8080/api/find?q=10k
curl http://rack.local:8080/api/locate?cell=A3
curl 'http://rack.local:8080/api/add?cell=A3&n=5'
```

`GET /api` lists every route. `GET /api/bootstrap` is status + config + inventory in one request.

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
| GET | `/api/update` | Current vs GitHub latest |
| POST | `/api/update/check` | Fetch `version.json` from the rolling release |
| POST | `/api/update/install` | Flash LittleFS then firmware, reboot |

WebSocket `/ws` pushes `status`, `dirty`, walk highlights, and `ota` progress.

## Firmware updates

Every push to `main` builds with PlatformIO and replaces the GitHub Release tagged **`latest`**:

- `firmware.bin`
- `littlefs.bin` (web UI)
- `version.json` (`version`, `git`, `built`)

The device is hardcoded to `neooriginal/ElectronicRack`. About 4 seconds after Wi-Fi comes up it checks:

`https://github.com/neooriginal/ElectronicRack/releases/latest/download/version.json`

If the git hash differs, Setup → Firmware shows **Install update**. That pulls the two `.bin` files from the same release over HTTPS and reboots.

USB flash this build once (partition table changed to dual-OTA). After that, OTA is enough.
