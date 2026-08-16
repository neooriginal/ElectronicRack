# ElectronicRack BLE protocol

The rack is a Bluetooth LE peripheral. The browser is the central: it holds the
connection, reads the rack's identity, and drives the LEDs. Inventory lives in the
server's SQLite database, keyed by the rack's own `rackId` — never on the ESP32.

Web Bluetooth does not expose a peer's MAC address (`BluetoothDevice.id` is opaque
and scoped to the browser profile), so the rack reports its own identity instead.

## Service

`Rack service` — `6e5f0001-b5a3-f393-e0a9-e50e24dcca9e`

| Characteristic | UUID suffix | Props | Payload |
| --- | --- | --- | --- |
| Identity | `…0002…` | read | JSON `{ "rackId", "fw", "leds", "rows", "cols" }` |
| Secret | `…0003…` | read | 32 hex chars, the rack's DB key |
| Command | `…0004…` | write, write-no-rsp | JSON command, see below |
| Event | `…0005…` | notify | JSON event, see below |
| OTA control | `…0006…` | write, notify | see `ble-ota.md` |
| OTA data | `…0007…` | write-no-rsp | firmware chunk |

Full UUIDs replace the `0001` group in the service UUID.

## Identity

Generated once on first boot and kept in NVS (`rackid` namespace):

- `rackId` — 12 hex chars derived from the efuse MAC. Stable for the life of the board.
- `secret` — 128 random bits, hex encoded. The only credential protecting this
  rack's rows in the database. Anyone within BLE range can read it, so physical
  proximity is the trust boundary.

## Commands (browser → rack)

Written as compact JSON to the Command characteristic. `t` is the type.

```jsonc
{ "t": "locate", "row": 2, "col": 1 }          // pulse one bin
{ "t": "flash",  "row": 2, "col": 1, "color": "#3DDC84", "ms": 420 }
{ "t": "stock",  "cells": [ { "row":0, "col":0, "color":"#C084FC", "qty":12 } ] }
{ "t": "mode",   "mode": "idle" }              // idle|off|startup|corners|walk|stop
{ "t": "identify", "index": 7 }                // light one raw LED, for mapping
{ "t": "grid",   "rows": 6, "cols": 6 }
{ "t": "wiring", "origin": "top-left", "rowFirst": true, "serpentine": true,
                 "offset": 0, "overrides": { "12": 30 } }
{ "t": "leds",   "pin": 13, "count": 36, "order": "GRB",
                 "brightness": 72, "idleBrightness": 18,
                 "idleAnim": "breathe", "startupAnim": "cascade",
                 "locateColor": "#3DD6E0" }
```

`leds` is persisted to NVS because the strip cannot light at all without the right
pin, count and colour order. Everything else is held in RAM and re-pushed by the
browser on each connect — the rack stores no inventory.

The Command characteristic accepts writes up to the negotiated MTU. Longer
payloads (a full `stock` snapshot for a large rack) are split by the browser:

```jsonc
{ "t": "stock", "seq": 0, "more": true,  "cells": [ ... ] }
{ "t": "stock", "seq": 1, "more": false, "cells": [ ... ] }
```

The rack buffers until it sees `more: false`, then applies the whole set at once.
A `seq` that arrives out of order discards the buffer and the rack emits
`{"t":"err","of":"stock"}` so the browser can resend.

## Events (rack → browser)

```jsonc
{ "t": "ready" }                                  // sent once after connect
{ "t": "walk", "row": 1, "col": 2, "led": 8 }     // calibration walk position
{ "t": "ack",  "of": "stock" }
{ "t": "err",  "of": "stock", "why": "seq" }
```

## Connect sequence

1. `requestDevice({ filters: [{ services: [rack service] }] })`
2. Read Identity and Secret.
3. `POST /api/session` with `{ rackId }` and `Authorization: Bearer <secret>`;
   the server creates the rack row on first sight and returns a session cookie.
4. Load inventory and config from the server.
5. Push `leds`, `grid`, `wiring`, then the `stock` snapshot to the rack.
6. Subscribe to Event notifications.
