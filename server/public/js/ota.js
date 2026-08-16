// Firmware updates over BLE. The rack has no internet access any more, so the
// browser fetches the release and streams it — see docs/ble-ota.md.

const SERVICE = "6e5f0001-b5a3-f393-e0a9-e50e24dcca9e";
const CHAR_CONTROL = "6e5f0006-b5a3-f393-e0a9-e50e24dcca9e";
const CHAR_DATA = "6e5f0007-b5a3-f393-e0a9-e50e24dcca9e";

const GITHUB_REPO = "neooriginal/ElectronicRack";
const VERSION_URL = `https://github.com/${GITHUB_REPO}/releases/latest/download/version.json`;
const FIRMWARE_URL = `https://github.com/${GITHUB_REPO}/releases/latest/download/firmware.bin`;

// CRC32 (IEEE 802.3), matching the ESP32 ROM implementation the firmware checks
// against. Computed client-side so a corrupted download is caught before flashing.
function crc32(bytes) {
  let table = crc32._table;
  if (!table) {
    table = crc32._table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export async function checkUpdate(currentFw) {
  const r = await fetch(VERSION_URL, { cache: "no-store" });
  if (!r.ok) throw new Error("could not reach GitHub releases");
  const info = await r.json();
  return { available: info.version && info.version !== currentFw, latest: info.version, notes: info.notes || "" };
}

// `device` is the connected BluetoothDevice from ble.js's rack.device.
export async function install(device, onProgress) {
  const svc = await device.gatt.getPrimaryService(SERVICE);
  const control = await svc.getCharacteristic(CHAR_CONTROL);
  const data = await svc.getCharacteristic(CHAR_DATA);

  onProgress({ phase: "downloading", pct: 0 });
  const resp = await fetch(FIRMWARE_URL, { cache: "no-store" });
  if (!resp.ok) throw new Error("firmware download failed");
  const buf = new Uint8Array(await resp.arrayBuffer());
  const crc = crc32(buf);

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      control.stopNotifications().catch(() => {});
      fn(arg);
    };

    control.addEventListener("characteristicvaluechanged", (e) => {
      let msg;
      try {
        msg = JSON.parse(new TextDecoder().decode(e.target.value));
      } catch {
        return;
      }
      if (msg.t === "progress") {
        onProgress({ phase: "flashing", pct: Math.round((msg.written / msg.size) * 100) });
      } else if (msg.t === "done") {
        onProgress({ phase: "done", pct: 100 });
        done(resolve);
      } else if (msg.t === "error") {
        done(reject, new Error("rack reported: " + msg.why));
      }
    });

    (async () => {
      await control.startNotifications();
      await control.writeValue(
        new TextEncoder().encode(JSON.stringify({ t: "start", size: buf.length, crc32: crc.toString(16) }))
      );

      // MTU minus ATT header; conservative so it works even without an MTU
      // upgrade. Small pause between writes lets the BLE stack drain its queue
      // instead of silently dropping writes under back-pressure.
      const CHUNK = 180;
      for (let i = 0; i < buf.length; i += CHUNK) {
        // eslint-disable-next-line no-await-in-loop
        await data.writeValueWithoutResponse(buf.subarray(i, i + CHUNK));
        if (i % (CHUNK * 4) === 0) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 15));
        }
      }
    })().catch((err) => done(reject, err));
  });
}
