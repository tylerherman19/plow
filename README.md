# Plow

Live snowplow dashboard for Plymouth, Minnesota: where every truck is right now,
where it has driven, who is salting, and how much snow is coming.

**Live:** https://tylerherman19.github.io/plow/

## What's on the page

- **Map:** live truck positions (arrow = moving, with heading; hollow = stopped),
  plus trails colored by age. Choose a 1, 3, 12 or 24 hour window. Salting shows in orange.
- **Fleet summary:** snow trucks moving and on the road, trucks salting now, miles driven
  in the window, and road/air temperature from truck sensors when they report it.
- **Truck list:** every snow-fleet truck (plows and cul-de-sac trucks) with its status, speed,
  last report, and miles driven. Tap one to fly to it and highlight its route.
  Switch to **All city** to include sweepers, utilities, and other vehicles.
- **Snow forecast:** NWS snowfall for the next 24 and 48 hours, the next four forecast
  periods, and any active NWS alerts (e.g. Winter Storm Warning).
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
