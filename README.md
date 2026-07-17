# DawlishSST-public

Public data feeds for Friends of the River Teign:

- `daily_sst_status.json` — daily sea-temperature summary
- `latest_ea_water_quality.json` — latest Environment Agency bathing-water data
- `latest_water_watch.json` — latest Bactiquick result for each Water Watch site

The Water Watch feed is refreshed from the public River Hub site by a scheduled GitHub Action during August mornings. River Hub site IDs and the indicator thresholds are configured in `water_watch_sites.json`.
