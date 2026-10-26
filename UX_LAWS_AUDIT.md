# UX Laws Audit: Taxi fleet monitor

- Build: v0.1.0, first build (no earlier audit history)
- Date: 2026-10-26
- Scope: live map and list, selection card, filters, replay bar, driver-phone page
- Viewports: 1440×900 desktop, 390×844 phone (headless Chrome via DevTools)
- Reviewer: BuildMe Claude session (automated review plus browser checks; no human usability test)
- Evidence: screenshots taken during the review (desktop live view, selection card, replay at 5 minutes, phone layout); console clean of errors after the fixes below; server tests `npm test` (7 passing); API checks for ingest validation, token auth, body limit.

## Audit

| Law | Status | Evidence / Notes | Required Fix |
|---|---|---|---|
| Fitts's Law | Compliant | Filter chips, list rows, search, Live and Close buttons all have `min-height: 44px` (`src/styles.css`). Click-to-select uses a 24 px hit radius around each taxi. Phone zoom buttons are hidden so pinch-zoom takes over from the vehicle sheet. | None |
| Hick's Law | Compliant | Five filter chips; the default path is the live map with the full list, one tap to focus a taxi. | None |
| Jakob's Law | Compliant | Familiar patterns: search box, segmented filter chips, list with selection, range slider for replay, standard map controls. | None |
| Miller's Law | Compliant | Summary has four counts. List is grouped by status through filters, and alerted taxis sort first. | None |
| Tesler's Law | Compliant | The system derives status, alerts and ordering from raw pings. Operators do not compute speed or idle time. Stale and out-of-order pings are handled automatically. | None |
| Aesthetic-Usability Effect | Compliant | One set of colour tokens and one spacing scale across HUD panels. Screenshots show consistent type, alignment and status colours. | None |
| Doherty Threshold | Partial | Live updates are throttled to 4 Hz on the server and the list is capped at 200 rows. No measured interaction latency exists yet, so this cannot be stated as met. Reason: no timing run was done in this review. | Measure click-to-card latency with a performance trace on a 200-taxi run, then record the result here. |
| Peak-End Rule | Partial | Key moments have feedback: connection state in the header, "Connection lost. Retrying…", and the empty-replay message. There is no designed onboarding or completion moment, which this monitoring tool does not need. Reason: the peak moments are mostly error states. | None required; revisit if a driver onboarding flow is added. |
| Serial Position Effect | Compliant | Key totals sit in the top bar, the most urgent taxis (alerts) head the list, and the replay control sits at the bottom where the eye lands after the list. | None |
| Von Restorff Effect | Compliant | Alerts are the only red elements: red badge in the list, red ring on the map, red value in the Alerts count. Status colours are kept distinct from the alert colour. | None |
| Pareto Principle | Compliant | The live map, list and alerts cover the common tasks. Less common features (trails, replay) are secondary and do not add to the main view. | None |
| Occam's Razor | Compliant | Only one map, one list, one card, and one replay bar. No extra dashboards or settings panels. | None |
| Postel's Law | Compliant (deliberate strictness) | Server input is strict on purpose: ingest rejects unknown or invalid fields with a named error, because it is a trust boundary and the workflow forbids loosening validation for robustness. The driver page is tolerant where it should be: missing speed or heading defaults to 0 instead of failing. | None |
| Zeigarnik Effect | Partial | Progress is visible for the two ongoing states: connection and replay position ("Replay 5 min ago"). There are no multi-step tasks, so the effect has little to act on. Reason: the app has no unfinished flow to track. | None required. |

## Defects found and fixed during this review

1. **Taxis not drawn**: the layer used the old maplibre-gl v5 render signature. Fixed by using `options.defaultProjectionData.mainMatrix` (v6 API).
2. **Taxis drawn at the wrong place**: the fleet origin was passed as an array. Fixed to a `{lng, lat}` object.
3. **Map workers failed in dev**: Vite pre-bundling broke the MapLibre worker URL. Fixed by excluding `maplibre-gl` from `optimizeDeps`.
4. **Alert flood**: the simulator made 25 of 60 taxis speed. Fixed simulator speeds so speeding is a rare event.
5. **Replay showed a blank map with no explanation** when history was missing. Added an empty-replay message.
6. **Phone replay bar wrapped awkwardly and zoom buttons covered the list**. Compacted the replay row and hid the bottom-right zoom controls on phones.
7. **Oversized requests dropped the connection instead of replying**. Changed to 413.

## Re-audit

All 14 laws are Compliant or justifiably Partial. Two Partials need follow-up:

- Doherty Threshold: needs a measured latency run.
- Zeigarnik and Peak-End: justified by scope, no action needed now.

Violations of a UX law still open: 0. The seven defects above were build defects found during this review, and all are fixed.

## Build 0.2: driver accounts, owner desk, driver reports

- Date: 2026-10-26
- Scope: owner desk (sign-in, reports, messages, drivers), driver page (sign-in, sharing, reports, inbox), report pins on the map.
- Evidence: `npm test` (21 passing); API flow checked with curl (owner and driver sign-in, wrong password, ping bound to the driver's taxi, report cooldown, broadcast message, 413 body limit, restart persistence); dev build checked in headless Chrome at 1440×900 for the map with report pin, the owner desk (sign-in, reports, drivers, messages), and the driver page (sign-in, inbox with an unread broadcast).
- Not checked: the driver report buttons with a real GPS fix, the driver page and owner desk at 390×844, phones, Safari, and the production build (it showed a blank map, see README).

| Law | Status | Evidence / Notes | Required Fix |
|---|---|---|---|
| Fitts's Law | Compliant (desk and driver page) | All new buttons and inputs are at least 44px high; driver report buttons are 56px, Start sharing is 56px. Report pins have a 44px hit area around a 20px dot. | Phone-width check of the desk still needed |
| Hick's Law | Partial | The desk stacks four sections in one scroll. Reports come first, which is the most urgent. Driver page has five report choices, one per emergency type. | Consider tabs if the desk grows |
| Jakob's Law | Compliant | Standard sign-in form, select-and-type message composer, Remove with two taps like most admin lists. | None |
| Miller's Law | Compliant | Desk headings show counts (open reports, drivers). Driver inbox and desk lists show the newest 30 to 100 items. | None |
| Tesler's Law | Compliant | The server applies the taxi ID and the report location, so the driver does not type either. Duplicate and cooldown rules are enforced by the server. | None |
| Aesthetic-Usability Effect | Compliant | New desk and driver panels use the same tokens and panel style as the map HUD. | None |
| Doherty Threshold | Partial | Not measured. Owner desk refreshes every 10 s and the driver inbox every 15 s, so new items can take that long to appear. | Measure send-to-appear latency and decide whether the WebSocket should push messages |
| Peak-End Rule | Partial | Sent messages and reports show a short status line ("Sent.", "Driver removed.", "… sent to dispatch."). Errors use plain text from the server. No end-of-task summary. | Acceptable for a dispatch tool |
| Serial Position Effect | Compliant | Newest messages and reports are at the top of their lists. | None |
| Von Restorff Effect | Compliant | Rescue alerts use the alert red; other report types use distinct colours. Open reports pulse on the map. | None |
| Pareto Principle | Compliant | Reports, messages and driver list cover daily use. Less common tasks (adding drivers) sit at the bottom. | None |
| Occam's Razor | Compliant | No new pages beyond the desk overlay and the driver page. No new dependencies. | None |
| Postel's Law | Compliant (deliberate strictness) | Server rejects bad types, text length, unknown recipients and missing locations, with named errors. Driver page sends only fields the user filled in. | None |
| Zeigarnik Effect | Compliant | A report stays "open" until acknowledged, then "resolved", and the desk shows the open count. The count is also in the top bar. | None |

Violations still open: none recorded. Items marked Partial need follow-up: Doherty latency measurement, phone-width check of the desk and driver page, and the production map worker.

## Build 0.3: dashboard tab, traffic layer, refinement pass

- Date: 2026-10-26
- Scope: Map / Dashboard tabs, dashboard (KPIs, two charts, slow zones, reports feed, taxi table), traffic layer on the map, header redesign, phone layout, production map fix, WebSocket push for desk changes.
- Evidence: `npm test` 29 passing; production build (`npm run build && npm start`) checked in headless Chrome at 1440×900 and at the narrowest window the tool allowed (500×844) for both tabs; tooltip shown on hover; push checked with a script (desk feed: 1 notice per change and no fleet data; live feed: snapshots and stats with deskVersion changing). Chart colours checked with the dataviz palette validator.
- Not checked: a real phone, Safari, Lighthouse scores, a measured interaction latency, the desk at phone width after this pass.

| Law | Status | Evidence / Notes | Required Fix |
|---|---|---|---|
| Fitts's Law | Compliant | Tabs, locate buttons, sort headers and chips are 40–44px or larger; locate buttons are 44×44. | None |
| Hick's Law | Compliant | Two tabs only. The dashboard reads top to bottom: 6 numbers, 2 charts, 2 lists, 1 table. | None |
| Jakob's Law | Compliant | Segmented tabs, sortable table headers with arrows, search with a magnifier, location-pin "show on map" buttons. | None |
| Miller's Law | Compliant | Six KPI tiles; slow zones capped at 8 and the reports feed at 8; table limited to 200 rows with search. | None |
| Tesler's Law | Compliant | The server works out trips, distance, stopped time and slow zones; the owner sees results, not raw pings. | None |
| Aesthetic-Usability Effect | Compliant | One token set (green, white, one alert red); validated chart palettes; tabular numbers throughout. | None |
| Doherty Threshold | Partial | Stats arrive every 5 s and snapshots up to 4 per second; desk changes now push in under a second (measured 0.6 s in the push script). Click-to-response latency not measured. | Run a performance trace on a real phone |
| Peak-End Rule | Compliant | Locate buttons land on the exact taxi, zone or report on the map, closing the loop from number to place. Empty states explain what will appear and when. | None |
| Serial Position Effect | Compliant | Headline numbers first, detail table last; urgent items (jams, alerts) are red and sit in the first row. | None |
| Von Restorff Effect | Compliant | Red is reserved for alerts, jams and rescue reports; the alert tile turns red only when there are alerts. | None |
| Pareto Principle | Compliant | The dashboard answers the daily questions (how many are working, where is traffic, what did drivers report) without opening the map. | None |
| Occam's Razor | Compliant | No chart library; two chart types; no settings screen. | None |
| Postel's Law | Compliant (deliberate strictness) | Server inputs unchanged and strict. The dashboard tolerates missing stats (loading and empty states). | None |
| Zeigarnik Effect | Compliant | "History since 12:05 (server started 9 min ago)" shows how complete the data is; open reports stay counted until resolved. | None |

Defects found and fixed in this pass:

1. Production map blank ("Worker failed to load"): MapLibre looked for its worker next to the bundled file. Fixed with `setWorkerUrl` and Vite's `?url`, plus a JS MIME type for `.mjs` in the server.
2. Taxis forced a repaint every frame, keeping the GPU busy; now repaints only on change and at the sprite's 4 fps.
3. Phone dashboard scrolled sideways: hidden table labels escaped the table's scroll box. Fixed with `position: relative` on the box.
4. Phone filter chips collapsed to empty outlines inside the list sheet. Fixed by letting only the list shrink.
5. Slow zones showed false 0 km/h jams from parked taxis. Fixed with one vote per taxi, ignoring free taxis standing still and stops over 2 minutes; the simulator now parks only free taxis and cruises at 25–45 km/h.
6. The alert tile turned red when alerts were 0 but a report was open.

Performance budget: the app bundle is 507 KB gzipped (budget 250 KB). Not met; MapLibre and three.js are most of it. Recorded in README.

---

## UX Laws Audit: v0.4 sign-in (owner / driver), driver page, driver accounts

- Build: v0.4 (sign-in gate, name + PIN driver sign-in, taxi details, profile-only driver page)
- Date: 2026-10-26
- Scope: sign-in screen (`/`, `/?as=driver`), owner desk driver list and add/edit form, driver page (`/driver.html`), owner top bar sign-out
- Viewports: 1568×759 desktop (Chrome, the user's window); 390×844 via same-origin iframes inside that window (the window itself could not be resized)
- Reviewer: BuildMe Claude session (browser walkthrough plus code review; no human usability test)
- Evidence: `npm test` 32 passing (desk: PIN rules, unique names, case/space-insensitive sign-in, per-name lockout, PIN reset ends sessions, legacy record without PIN); curl checks (map endpoints 401 without owner token, 200 with it, 401 with a driver token; socket without auth closed with 4401; owner socket gets snapshot + stats); browser walkthrough: wrong owner password, owner sign-in, reload keeps the session, desk add driver, duplicate name refused, driver sign-in as "MARIA  santos", owner edit reaching the open driver page in about 2 s, driver sign-out to `/?as=driver`; console clean of errors; measured button sizes at 390 px.
- Not checked: a real phone, Safari, Lighthouse scores, screen reader (VoiceOver/TalkBack), measured interaction latency.

| Law | Status | Evidence / Notes | Required Fix |
|---|---|---|---|
| Fitts's Law | Compliant | At 390 px: role buttons 153×44, fields 320×48, show/hide 44×44, submit 320×52; driver page Sign out 90×44, Start sharing 311×56; console top bar Desk and Sign out 44×44. Desk form fields 44 px high. | None |
| Hick's Law | Compliant | Sign-in has one choice (Owner / Driver) then one or two fields. The driver page has one action (start sharing) and one exit (sign out). | None |
| Jakob's Law | Compliant | Segmented role switch, labelled fields, a show/hide eye on secret fields, the usual sign-out icon, date picker for franchise expiry. | None |
| Miller's Law | Compliant | Driver page in four short groups (profile 3 facts, taxi 5 facts, right now 4 tiles, location). The desk form splits into "Driver" and "Taxi" fieldsets. | None |
| Tesler's Law | Compliant | The system absorbs name formatting (case, extra spaces), works out franchise days left, and fills live status from the GPS feed. The driver types only name and PIN. | None |
| Aesthetic-Usability Effect | Compliant | Same tokens as the console (green, white, one alert red, amber for warnings); sign-in card matches the console panels; screenshots at both widths are aligned after the label-column fix below. | None |
| Doherty Threshold | Partial | Sign-in route is 74 KB gzipped (the 457 KB map console loads only after owner sign-in); owner edits reach an open driver page in about 2 s through the desk socket. Click-to-response latency not measured on a phone. Reason: no phone or performance trace available in this session. | Run a performance trace on a real phone over mobile data |
| Peak-End Rule | Compliant | Success moments are explicit: "Added Maria Santos. They sign in as “Maria Santos” with the PIN you set.", "Signed out." on the sign-in screen, the driver lands on a page with their own name as the heading. Failures say what to do ("Use your name exactly as the owner registered it", "The owner can set a new one"). | None |
| Serial Position Effect | Compliant | Driver page: name first, then profile and taxi (what the driver checks), live numbers, and the sharing button last where the thumb ends. Sign-in: role choice first, primary button last. | None |
| Von Restorff Effect | Compliant | Red badges only for "Franchise expired" and "No PIN: cannot sign in"; amber only for "expires in N days". | None |
| Pareto Principle | Compliant | The driver page covers what drivers need daily (who am I, which taxi, is it sending) and nothing about other taxis. | None |
| Occam's Razor | Compliant | One sign-in screen for both roles instead of two; messaging UI removed because drivers can no longer read it. | None |
| Postel's Law | Compliant (deliberate strictness) | Tolerant where safe: names match regardless of case and spacing; PIN field opens the number pad. Strict at the trust boundary: PIN must be 4-6 digits, names unique, taxi fields length-checked, franchise date validated, unknown names get the same message and timing as wrong PINs. | None |
| Zeigarnik Effect | Compliant | Unfinished setup is visible: drivers without a PIN show "No PIN: cannot sign in" in the desk; empty taxi fields read "Not recorded yet" on the driver page. | None |

Defects found and fixed in this pass:

1. Map collapsed to 0 px after sign-in: `maplibre-gl.css` now arrives with the lazy console chunk, after `styles.css`, and its `.maplibregl-map { position: relative }` won. Fixed with a two-class selector (`.app .map`).
2. Phone: the Desk button's label used `display: none`, leaving an icon-only button with no accessible name (existed before this pass). Now visually hidden but still read out; the new Sign out button uses the same rule.
3. The role switch used `role="radio"` without arrow-key support. Changed to toggle buttons (`aria-pressed`) in a labelled group.
4. "Signed out." stayed visible after switching to the driver form. Now cleared on role change.
5. Server errors showed as lower-case fragments ("another driver already has that name…"). Now shown as sentences.
6. Driver page label columns did not line up between the profile and taxi cards. Fixed column width.

Gates: anti-slop grep of the new copy found no banned words; no gradients or new colours added. Lighthouse not run (DevTools MCP browser was locked by another session); BLOCKED for the measured-performance part only, carried over as the Doherty Partial above. The console bundle stays over the 250 KB budget, as recorded in the previous audit; the new sign-in route is within it.
