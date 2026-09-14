# Plow

Live snowplow tracker for Plymouth, Minnesota. A dark, cinematic map where plows
glide as points of light and their last two hours hang behind them as fading trails.

**Live:** https://tylerherman19.github.io/plow/

## How it works

- Static page — no backend, no database, no build step.
- Plow GPS comes from the City of Plymouth's public ArcGIS feed
  (`PreCiseAssets/MapServer`, a PreCise AVL system):
  - Layer 0 — current plow locations, polled every 5 seconds
  - Layer 2 — plowed/treated in the past 3 hours, filtered to the last 2 hours for trails
- The city feed sends no CORS headers, so the page reads it via JSONP.
- The refresh switch has three states: **ON** / **AUTO** / **OFF**.
  In AUTO, the page checks the National Weather Service forecast for Plymouth
  (free, no key) and only goes live when ~1+ inch of snow is expected in the next 24 hours.
- "Miles / 2 hrs" is computed from the GPS trails — no geocoding, no guessing.
- Off-season the feed returns zero records; the page shows a quiet
  "The plows are asleep" state instead of an empty map.

## Notes

- Cul-de-sacs are not covered by the city's plow data.
- Respect `prefers-reduced-motion`: marker easing is disabled.
