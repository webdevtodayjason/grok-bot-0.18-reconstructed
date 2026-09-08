export const SAND_UPGRADE_RESUME_FILE_NAME = "host-upgrade-resume.json";
export const SAND_ACK_OBLIGATIONS_FILE_NAME = "ack-obligations.json";
export const SAND_PENDING_WAKE_FILE_NAME = "host-pending-wakes.json";
export const SAND_XUSER_TURN_DEDUPE_FILE_NAME = "host-xuser-turn-nonces.json";
export const SAND_DISK_PRESSURE_REMINDERS_FILE_NAME = "host-disk-pressure-reminders.json";
// The two files in sand-data that hold credentials, and therefore the two the box store may never
// take a copy of. PROXY-1 / SECRET-3.
//
// MEASURED ON THE R750 2026-09-08. The migration removed the operator's 113-character provider key
// from box-secrets.json in all three customer boxes and proved it gone by reading that file back.
// It was not gone: box-store-sync had already copied the file into the box's own content-addressed
// store, so a byte-identical 539-byte copy of the same key sat at
// /var/lib/sand-box-store/<store id>/blobs/<sha256>, mode 0644 root:root, in every box -- and the
// agent host runs as root inside the box, so any shell tool call a customer's agent makes could
// read it. A removal that does not reach the store removes nothing.
//
// Excluding them costs nothing that matters. Neither file is the customer's data: box-secrets.json
// is written by the console on every model change and by the control plane at provisioning, and
// connector-env-secrets.json is written by the connector editor. A box that came back with an empty
// one gets it rewritten on the next change from the console, which owns both. What the exclusion
// buys is that a credential never enters a durable copy nobody remembers exists.
export const BOX_STORE_SECRET_FILE_NAMES = ["box-secrets.json", "connector-env-secrets.json"] as const;
export const BOX_STORE_SAND_DATA_EXCLUDED_FILE_NAMES = [SAND_UPGRADE_RESUME_FILE_NAME, SAND_ACK_OBLIGATIONS_FILE_NAME, SAND_PENDING_WAKE_FILE_NAME, SAND_XUSER_TURN_DEDUPE_FILE_NAME, SAND_DISK_PRESSURE_REMINDERS_FILE_NAME, ...BOX_STORE_SECRET_FILE_NAMES] as const;
