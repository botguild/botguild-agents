# Fly.io Log Drain → Axiom

1. Create a dataset in Axiom (axiom.co) named `botguild-agents`
2. Get your Axiom API token from Settings → API Tokens
3. Add the log drain for each app:
   fly logs drain create "https://api.axiom.co/v1/datasets/botguild-agents/ingest" \
    --header "Authorization=Bearer <AXIOM_TOKEN>" \
    --app botguild-sentinel-bot
   # repeat for flow-bot and verifier-bot
4. Alternatively use Logtail: fly logs drain create "https://in.logtail.com" \
    --header "Authorization=Bearer <LOGTAIL_TOKEN>" \
    --app botguild-sentinel-bot
