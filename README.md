# Plow

Live snowplow dashboard for Plymouth, Minnesota: where every truck is right now,
where it has driven, who is salting, and how much snow is coming.

**Live:** https://tylerherman19.github.io/plow/

## What's on the page

- **Fleet now:** snow trucks moving, trucks salting right now, miles driven since midnight,
  and average road temperature from truck sensors when they report it.
- **Snow forecast:** a table with snow, temperature range and wind for the next 24 hours,
  the next 48 hours and the next four NWS forecast periods. Any active NWS alerts appear above it.
- **Trucks:** a table with status (Moving, Moving + Salting, Salting (stopped), Idle, Parked),
  speed, last report and miles. Select a row to fly to that truck and highlight its route.
  Switch between the snow fleet (plows and cul-de-sac trucks) and all city vehicles.
- **Map:** live trucks, trails shaded by age with a 1, 3, 12 or 24 hour window,
  orange dots where a truck was salting, a summary chip, and a my-location button.
- When there's no snow in the forecast and nobody is salting, a banner explains that
  trucks on the map are doing regular street work, not plowing.

## How it works

- Static page. No backend, no database, no build step.
- Vehicle GPS comes from the City of Plymouth's public ArcGIS feed
  (`PreCiseAssets/MapServer`, a PreCise AVL system), read via JSONP:
  - Layer 5 (current vehicle location) is polled every 5 seconds.
  - Layer 4 (all GPS breadcrumbs, about 4 weeks) is queried by time for trails.
    After the first load, only new records are fetched, every 30 seconds.
- "Salting" = the spreader reports a non-zero granular, prewet or direct-liquid rate.
- Polling pauses while the tab is hidden.
- Forecast and alerts come from api.weather.gov (free, no key).
- Light and dark themes follow the system setting. Respects `prefers-reduced-motion`.
