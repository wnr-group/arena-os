# Kitchen & receipt printing (M19 / AROS-175)

## Path chosen: cloud-print (Star CloudPRNT), no local agent

The app runs in the cloud; printers sit on the venue LAN. A server can't open a
socket to them and browser JS can't open raw TCP, so the **printer pulls**:

```
order fired / bill raised ──► print_jobs (tenant-scoped queue, ESC/POS bytes stored)
                                   ▲  POST poll   (every few seconds)
   Star printer on venue LAN ──────┤  GET  job bytes
        (CloudPRNT enabled)        └─ DELETE confirm (code=OK | error)
        https://<app>/api/cloudprnt/<printerId>/<secret>
```

No bridge to install, no inbound firewall rules. Browser web-print
(`/kitchen/[kotId]/print`, invoice "Print / Save as PDF") is unchanged and is the
fallback whenever no printer is configured.

* Bytes are rendered **at enqueue time** (`lib/printing/render.ts` →
  `escpos.ts`), so a retry/reprint is byte-identical and the endpoint has no
  business logic.
* The endpoint is machine-to-machine: printer id + secret in the URL. Only the
  SHA-256 is stored; it reaches the DB solely through the `cloudprnt_*`
  SECURITY DEFINER functions (migration 0149), each re-verifying the secret.
  "New URL" in the UI rotates it.

## Setup (manager)

1. Plan needs `module.printing`. Kitchen → *Printers & print queue*.
2. *Add printer* (kitchen tickets or receipts/bills, 58/80 mm). Copy the Server
   URL **shown once**; in the printer's web config enable CloudPRNT and paste it.
   The printer must be in **ESC/POS** emulation.
3. *Test print* proves URL, secret and media type end to end.
4. Stations → printer: map each station to a kitchen printer; the first kitchen
   printer is the default and takes unrouted lines.

## What prints

| Event | Paper |
|---|---|
| Staff order placed (accepted) | one ticket per printer (station→printer, else default) |
| Online order accepted by staff | same |
| Course fired | only the lines just fired, marked `*** FIRE ***` |
| Bill raised (`createInvoiceForBooking`) | bill on the branch receipt printer |
| Invoice page → *Print on receipt printer* | bill / receipt |

## Failures are never silent

`print_jobs.status`: pending → sent → printed | failed | cancelled. The kitchen
screen shows a red banner when a job is **failed** (printer returned an error
code, e.g. paper out), **not confirmed** (sent > 2 min, no confirmation),
**waiting too long** (pending > 2 min), or a printer **stopped polling**.
*Printers & print queue* lists them with **Retry**, **Dismiss** and a
*Print in browser* link. Nothing retries automatically (avoids double prints).

## Delivery guarantee: at most twice

`print_jobs.attempts` counts every delivery of the bytes to the device (migration
0170). The first fetch marks the job `sent`; if the printer prints but its
confirmation is lost, the job is re-offered **once** (a second fetch), then
never again — so a lost confirmation costs at most one duplicate, not one per
poll for five minutes. After that the job stays `sent` and shows as **not
confirmed** for staff to **Retry** (which resets the count) or **Dismiss**.

## Bounds and retention

* Every free-text field is capped (1,000 characters, 12 printed lines), runs of
  blank lines collapse, and one job is capped at 32 KB (`escpos.ts`). Over the
  cap the job is cut at a line boundary and ends with `*** TICKET TRUNCATED -
  SEE SCREEN ***` — staff see it and check the screen, nothing half-written is
  sent to the printer. Order notes are limited to 300 characters on entry.
* Finished jobs (printed / cancelled / failed) older than 30 days are deleted by
  the daily cron (`/api/cron/generate-events`, `lib/printing/retention.ts`).
  Pending and sent jobs are never pruned.

## Decisions

* **Non-Latin text prints as `?`.** Item, modifier and customer names in
  Devanagari, Tamil, other Indic scripts and emoji are not rendered; Latin
  accents and ₹ are transliterated. Chosen deliberately: the printer's code
  page is unknowable from the server and none of the common ones carry Indic
  scripts, so the only correct fixes are rasterising the ticket as an image (a
  second encoder, bigger jobs, slower print) or a per-model code page. Revisit
  as a separate feature if a venue needs it; until then enter item names in
  Latin script (the on-screen KDS shows the original text).
* **Media type is unconfirmed — open item, needs the pilot-venue spike.** The
  default is `application/vnd.star.starprnt` but the encoder emits ESC/POS
  (`GS ! n`, `GS V B`, `ESC d`). On a printer genuinely in StarPRNT mode those
  differ (bad sizing / cut). It has not been tested on hardware; do not ship to
  a venue without printing one real ticket and one receipt on their model and,
  if it garbles, switching that printer's media type (Setup → printer) or
  adding a StarPRNT encoder. This is not decided by code.

## Known limits / follow-ups

* **Spike with the pilot venue before committing hardware.** `media_type`
  (default `application/vnd.star.starprnt`) and ESC/POS emulation are per
  printer and must be confirmed on the real model; the driver emits only the
  common ESC/POS core (`ESC @/a/E/d`, `GS !/V`) and plain ASCII (₹ → "Rs").
* Star CloudPRNT only. Epson Server Direct Print polls with a different
  (XML) protocol — a second adapter on the same queue, not done.
* Online orders print without a member: an auto-accepted order prints from the
  public action after it commits, and a pay-now order from the payment webhook,
  both as the system, best-effort and at most once per order (a print problem
  never fails the order or the webhook).
* Not done (tracked separately): the receipt omits tip / IGST / round-off and
  does not net refunds; the printer secret is in the URL path (HTTP Basic would
  keep it out of logs) and bad secrets are not rate-limited; `print_jobs`
  printer/kot/invoice foreign keys are not tenant-composite.
* No cash-drawer kick, logo/QR, or non-ASCII scripts (see Decisions).
