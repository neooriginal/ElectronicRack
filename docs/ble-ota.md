# BLE OTA

Firmware updates travel the same BLE link as everything else. The browser is the
one with internet access — it fetches the new firmware from GitHub Releases (or
wherever `OTA_FIRMWARE_URL` points) and streams it to the rack in chunks, since
the stripped-down ESP32 no longer speaks Wi-Fi or HTTP.

USB flashing (`pio run -t upload`) still works and is the fallback if a BLE OTA
is interrupted — the rack boots the previous OTA partition either way, it is
never left unbootable by a failed update.

## Characteristics

Both are on the rack service (`docs/ble-protocol.md`).

**OTA control** — `…0006…`, write + notify

Write to start or cancel:

```jsonc
{ "t": "start", "size": 1234567, "crc32": "a1b2c3d4" }
{ "t": "abort" }
```

Notifies progress and outcome:

```jsonc
{ "t": "progress", "written": 40960, "size": 1234567 }
{ "t": "done" }
{ "t": "error", "why": "crc" }   // crc | write | too-large | flash
```

**OTA data** — `…0007…`, write-without-response

Raw firmware bytes, sent as consecutive chunks sized to the negotiated MTU minus
a few bytes of ATT overhead. No framing: the rack just appends every byte it
receives after `start` to the OTA partition until byte count reaches `size`.

## Sequence

1. Browser reads `/api/update` (proxied to the GitHub release) for the latest
   version and compares against the identity characteristic's `fw`.
2. Downloads `firmware.bin`, computes CRC32.
3. Writes `start` with `size` and `crc32` to OTA control.
4. Streams the file to OTA data in MTU-sized chunks, watching `progress` notifies
   to pace itself (do not queue more than a few chunks ahead of the last ack).
5. On `done`, the rack reboots into the new image automatically. On `error`, the
   old image is untouched — the browser can retry from step 3.

A rack that never receives `start` keeps running the current firmware
indefinitely; there is no forced-update path, matching how OTA worked before.
