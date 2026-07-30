# thumbforge-probe

The URL-probe leg of ThumbForge's §9 reachability gate: a trivial Worker on its own `workers.dev` hostname that `POST { url }` fetches with a cache-buster and returns `{ status, byteLength, ok }`, so the bot never fetches its own custom-domain zone (the err-1042 self-routing hazard).
Deploy first (`wrangler deploy`), keep its `workers.dev` hostname, then wire it to `thumbforge-bot`'s `PROBE` service binding.
