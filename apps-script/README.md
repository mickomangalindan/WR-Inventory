# Apps Script copies

Reference copies of the Google Apps Script files that run alongside the ERP, so the ERP bot and Claude can read them. **The live code is the one in Google Apps Script**; when you change a script there, update its copy here too.

No keys live in these files. Every secret (Supabase keys, Shopify token, Telegram token, Claude API key) is a Script Property in Apps Script and never belongs in this repo, because the repo is public.

| File | Apps Script project | What it does |
|---|---|---|
| `wr-erp-automations.gs` | automations web app | record PDFs to Drive, mentions, file uploads, demand sheet sync, keep-warm ping, activity and delivery reminders, daily Drive backup |
| `wr-shopify-inventory.gs` | Shopify project | hourly read of Shopify stock into `shopify_inventory` (read-only toward Shopify) |
| `wr-shopify-pull-webapp.gs` | Shopify project (same file as above, bottom) | the app's 🔄 Sync Shopify button; 90 s cooldown |
| `wr-shopify-sales.gs` | Shopify project | every 15 min, Shopify orders into `shopify_events` (read-only toward Shopify) |
| `wr-erp-bot.gs` | ERP bot (its own project) | Telegram helper: answers from data and code, files fixes for approval, Merge buttons for pull requests |

Copied 2 Nov 2026.
