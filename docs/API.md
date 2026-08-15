# Electronic Rack API

Base URL: `http://<ip>:8080` or `http://rack.local:8080`

JSON, no auth, LAN only. Cell names are `A1` (column letter + 1-based row).

On the device this file is also at **`/api.md`**. `GET /api` returns a machine-readable index.

## Quick API (GET, one line)

These are meant for curl, Shortcuts, bookmarks, and NFC tags.

| Call | What it does |
| --- | --- |
| `GET /api` | List every route |
| `GET /api/bootstrap` | Status + config + inventory in one shot |
| `GET /api/find?q=10k` | Search **stocked** parts |
| `GET /api/bin?cell=A3` | What’s in that bin |
| `GET /api/locate?cell=A3` | Pulse that bin’s LED |
| `GET /api/add?cell=A3` | Put one more in (`&n=5` for five) |
| `GET /api/take?cell=A3` | Take one out (`&n=5` for five) |

```bash
curl http://rack.local:8080/api/find?q=10k
curl http://rack.local:8080/api/locate?cell=A3
curl 'http://rack.local:8080/api/add?cell=A3&n=10'
curl 'http://rack.local:8080/api/take?cell=A3&n=1'
```

`add` / `take` change stock. Don’t cache them.

## Full API

### Status and config

`GET /api/status` — IP, heap, firmware, git, repo  
`GET /api/config` — grid, wiring, LEDs, per-cell LED map  
`PUT /api/config` — merge a partial config JSON, persist

### Inventory

`GET /api/inventory` — `{ items: [ … ] }`  
`PUT /api/inventory` — replace the whole list (restore)

Each item:

```json
{
  "id": "a1b2c3",
  "name": "10kΩ 1/4W 1%",
  "mpn": "",
  "sku": "",
  "category": "resistor",
  "package": "THT 1/4W",
  "brand": "",
  "color": "#E6A15C",
  "source": "local",
  "qty": 42,
  "locs": [{ "row": 2, "col": 0, "cell": "A3", "qty": 42 }]
}
```

### Stock (JSON POST)

`POST /api/stock/place` — put a part in a bin

```json
{ "name": "Flux pen", "category": "chemical", "cell": "B2", "qty": 3 }
```

`POST /api/stock/adjust` — `{ "cell": "A3", "delta": -1 }`  
`POST /api/stock/set` — `{ "cell": "A3", "qty": 20 }`  
`POST /api/stock/clear` — `{ "cell": "A3" }`  
`POST /api/stock/move` — `{ "from": "A3", "to": "C1" }`

### Lights

`POST /api/locate` — `{ "cell": "A3" }` (same as the GET)  
`POST /api/leds` — `{ "mode": "idle" }`

Modes: `idle`, `off`, `startup`, `corners`, `walk`, `stop`, `identify` (`index`), `locate` (`cell`).

`GET /api/calibrate/walk-step` — current cell while walking

### Catalog

`GET /api/catalog/remote?q=STM32` — live JLCPCB / LCSC (slow, HTTPS)

Local passives and named parts live in the web UI, not on the ESP32.

### Backup and updates

`GET /api/backup` — download config + inventory  
`POST /api/restore` — `{ "config": …, "inventory": … }`  
`POST /api/factory-reset`  
`GET /api/update` — current vs GitHub `latest`  
`POST /api/update/check`  
`POST /api/update/install` — writes LittleFS, then firmware, then reboots

## WebSocket `/ws`

JSON messages:

| `t` | Meaning |
| --- | --- |
| `status` | Periodic heap / IP |
| `dirty` | `{ "what": "inventory" \| "config" }` — reload |
| `walk` | Calibration walk highlight |
| `ota` | Update progress |

Send `{ "t": "ping" }` → `{ "t": "pong" }`.

## Errors

```json
{ "error": "bad cell" }
```

Typical codes: `400` bad input, `404` empty bin, `409` busy (OTA), `500` persist failed.
