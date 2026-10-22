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

## Known limits / follow-ups

* **Spike with the pilot venue before committing hardware.** `media_type`
  (default `application/vnd.star.starprnt`) and ESC/POS emulation are per
  printer and must be confirmed on the real model; the driver emits only the
  common ESC/POS core (`ESC @/a/E/d`, `GS !/V`) and plain ASCII (₹ → "Rs").
* Star CloudPRNT only. Epson Server Direct Print polls with a different
  (XML) protocol — a second adapter on the same queue, not done.
* Anonymous online orders (`placeOnlineOrder`, and pay-now orders released by the
  payment webhook) don't auto-print: there is no member to own a job under RLS,
  and the money path must not gain a print dependency. They print when staff
  accept (if review is on) or via the KDS / browser print.
* No cash-drawer kick, logo/QR, or non-ASCII scripts.
