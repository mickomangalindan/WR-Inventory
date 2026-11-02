/****************************************************************************************
 * Wholesome Rabbit — ERP Telegram bot  (Apps Script web app · Claude API)        2026-11-02
 * ----------------------------------------------------------------------------------
 * Mention the bot in a team chat (or DM it) and it answers questions about how the ERP
 * works and what the data says, by reading Supabase. READ ONLY: the only request it can
 * make to the ERP tables is a GET. It cannot change stock, orders, plots or POs.
 *
 * When it finds something that looks wrong it does NOT fix it. It files a fix proposal in
 * public.erp_bot_log and sends Zeus an Approve / Reject message. Approved fixes are done in
 * the claude.ai project (tested, deployed by Zeus), never by this bot.
 *
 * Every question, answer and fix is logged in public.erp_bot_log with its cost.
 *
 * PUT THIS IN ITS OWN APPS SCRIPT PROJECT. The automations project already has a doPost();
 * two doPost() functions in one project overwrite each other.
 *
 * ============================== SCRIPT PROPERTIES ==============================
 *   TELEGRAM_BOT_TOKEN   from @BotFather (a NEW bot, not the notifications bot)
 *   BOT_USERNAME         the bot's @username without the @, e.g. WRErpHelperBot
 *   ANTHROPIC_API_KEY    from platform.claude.com → API keys (the org holding your Max credit)
 *   WR_SERVICE_ROLE      Supabase service_role key (same as the automations project)
 *   OWNER_USER_ID        your Telegram numeric user id (approvals go here; you see costs)
 *   ALLOWED_CHAT_IDS     comma list of chat ids allowed to use the bot (groups are negative)
 *   (optional) CLAUDE_MODEL   default claude-haiku-5-5 · set claude-sonnet-5-5 for sharper answers
 *   (optional) DAILY_LIMIT    max questions per day for the whole team, default 60
 *   (optional) USER_HOURLY    max questions per person per hour, default 10
 *   (optional) DAILY_USD      spend cap per day in US$, default 1.50 (the bot pauses itself past it)
 *   (optional) GITHUB_TOKEN   fine-grained token for WR-Inventory only (Pull requests: read & write,
 *                             Contents: read & write). Lets you MERGE Claude's fixes from Telegram.
 *   (optional) GITHUB_REPO    default mickomangalindan/WR-Inventory
 *
 * ============================== SAFETY SWITCHES ================================
 *   In Telegram (owner only):  /pause   /resume   /usage   /fixes   /prs
 *   The bot also pauses ITSELF when today's spend passes DAILY_USD, and tells you.
 *   Hard stop: delete the API key in platform.claude.com — the bot goes silent at once.
 *   Money stop: the Max credit is $100/month; keep auto-reload OFF and no card on the
 *   Console, and when the credit is used up the API simply refuses — nothing is charged.
 *
 * ================================== SETUP ======================================
 *   1) Paste this file, set the properties above.
 *   2) Run installPolling() once (a 1-minute trigger; no web app or webhook needed).
 *      Do NOT also run setWebhook() — Telegram allows one or the other, and the webhook
 *      route is unreliable on Apps Script (see pollUpdates).
 *   4) (optional) set GITHUB_TOKEN, then run installPRWatcher() once.
 *   5) Run selfTest(). Then mention the bot in your group: "@WRErpHelperBot what is owed on
 *      CO-10202026 V01?"
 ****************************************************************************************/

var SUPABASE_URL = 'https://nzormnscflumffbekwvz.supabase.co';
var ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
var MAX_TOOL_ROUNDS = 8;   // lookups per question; after the last one it must answer with what it has

/* Tables the bot may read. Big ones must be filtered (no whole-table dumps). */
var READABLE = {
  products:1, ingredients:1, bom_lines:1, suppliers:1,
  custom_orders:1, custom_order_lines:1, production_batches:1, batch_issues:1,
  purchase_orders:1, po_lines:1, transfers:1, transfer_lines:1,
  count_sessions:1, count_lines:1, mrp_plans:1, demand:1,
  shopify_inventory:1, sales_momentum:1, shopify_events:1, variance_log:1,
  inventory_movements:1, stock_balance:1, erp_bot_log:1
};
var MUST_FILTER = { inventory_movements:1, shopify_events:1, batch_issues:1, count_lines:1, production_batches:1 };
/* Money is hidden from everyone except the owner (rule D6: cost is hidden from CS, Warehouse, Pasig). */
var MONEY_COL = /(cost|price|value|discount|fee|payment|_pct$|dp_pct|term_)/i;

/* Haiku 5.5 (prompts ≤100K), Sonnet 5.5 — USD per million tokens: in, out, cache read, cache write 5m */
var PRICES = {
  'claude-haiku-5-5':  [0.10, 0.50, 0.01, 0.125],
  'claude-sonnet-5-5': [2.00, 10.00, 0.10, 2.50],
  'claude-opus-5-5':   [4.00, 20.00, 0.20, 5.00]
};

/* ------------------------------------------------------------------------------------
 * WHAT THE BOT KNOWS ABOUT THE ERP. Kept short on purpose; it reads the live data for
 * the rest. Update this when RULES change (copy the gist of WR-ERP-RULES.md).
 * ---------------------------------------------------------------------------------- */
var PRIMER = [
'You are the Wholesome Rabbit ERP helper in the team Telegram chat. Answer briefly, in plain everyday words (English or Tagalog, matching the asker). No jargon. Lead with the answer.',
'FORMAT FOR TELEGRAM: plain text only. No ** or other markdown, no tables. For a list use one line per item starting with "- ".',
'You can READ the ERP database with the query tool. You can never change anything. If something looks wrong, say what you found and call propose_fix — Zeus approves fixes and they are done separately. Never claim you fixed anything.',
'If you are not sure, say so and say which screen to check. Never invent numbers: every figure you give must come from a query you ran.',
'THREE SOURCES, USE THE RIGHT ONE: the DATA (query) shows what happened; the CODE (search_code on index.html) shows how the app decides and whether a fix is really in place; the AUTOMATIONS are Apps Script jobs whose results you see in the data (shopify_inventory.fetched_at = the hourly Shopify pull, sales_momentum.refreshed_at = sales speed, app_settings key keepwarm_last_ping = keep-alive, erp_bot_log = this bot). For "is X fixed / why does the app do X" questions, check the code AND the data.',
'A record saved BEFORE a fix shipped cannot prove the fix works. The build date is in index.html as WR_BUILD (search_code "WR_BUILD="). Compare dates before concluding.',
'',
'THE BUSINESS. Fresh / novel-protein dog food. Two sites: bulacan = production kitchen (the ERP is its stock record); pasig = sell site (Shopify is the stock record for its finished packs).',
'',
'KEY RULES',
'- Stock is a ledger: sum of inventory_movements (view stock_balance: location_code, kind, ref_sku, on_hand). Finished packs at pasig are NOT in the ERP — read shopify_inventory (location_name=pasig; available = sellable, on_hand = physical). Ingredients, supplies and stickers at every site ARE in the ERP. Ingredient quantities are in grams; products in packs.',
'- Products have recipes in bom_lines (usable_g per pack). Ingredients are raw or processed (is_intermediate, source_sku, yield_pct). Production uses processed stock first, then raw at yield.',
'- Custom orders: custom_orders + custom_order_lines (packs, written_off_packs). Statuses: draft, for_production (For Demand Planning), in_demand, in_production, partial, completed, cancelled. Open = for_production, in_demand, in_production, partial. Completed means PRODUCED (not delivered). A closed-out order has written_off_packs and asks for nothing.',
'- "Made" for a custom order = confirmed production_batches (status=confirmed, kind not output). A batch with order_ref belongs to that order; the rest are shared oldest-promise-first. Still owed = packs − written_off_packs − made.',
'- Same recipe at the same pack size shares one CUST- SKU across orders on purpose.',
'- Dates on custom orders: delivery_date = promise to customer; needed_date = make-by (kitchen deadline); buy_by, prod_start, ready_date are the schedule.',
'- Demand plots: mrp_plans (data.demand = packs per SKU, data.lines = raw to buy, data.locked). The newest locked plot is the week\'s target. Regular packs round to 24 then steps of 12; custom quantities are never rounded. demand is only a cache.',
'- POs: purchase_orders (status open = not yet sent, confirmed, partial, received, cancelled) + po_lines (ordered_kg, received_kg). POs come only from the locked plot or Purchasing → New PO.',
'- Counts: count_sessions + count_lines (book_qty vs counted_qty). Only an approved count changes stock.',
'- Transfers bulacan→pasig post only transfer_out at Bulacan (packs leave the ERP).',
'- Shopify sales are in shopify_events (posted, post_error). Sales speed in sales_momentum (u30/u60/u90 = units sold).',
'- variance_log is information only — not a to-do list.',
'- Roles: Admin, Purchasing, Warehouse, Customer Service, Pasig, Finance, Delivery. Customer Service locks orders and plans the plot; Purchasing raises POs; the kitchen produces; Warehouse counts and transfers.',
'',
'TABLE COLUMNS (main ones)',
'products: sku, name, variant, pack_g, status, active, is_custom, supply_led, replaced_by, group_1, group_2',
'ingredients: sku, name, category, is_intermediate, source_sku, raw_input, yield_pct, supplier, lead_time_days, par_g, is_supply, active',
'bom_lines: product_sku, ingredient_sku, usable_g',
'custom_orders: order_ref, customer_name, status, order_date, needed_date, delivery_date, buy_by, prod_start, ready_date, plan_route, notes',
'custom_order_lines: order_ref, line_type, product_sku, description, packs, written_off_packs, pack_size_g, recipe',
'production_batches: batch_ref, run_ref, product_sku, status, kind, good_packs, planned_packs, production_date, order_ref',
'batch_issues: batch_ref, ingredient_sku, expected_raw_g, actual_raw_g, actual_processed_g',
'purchase_orders: po_ref, supplier_name, order_date, status, expected_delivery, received_at',
'po_lines: po_ref, ingredient_sku, ordered_kg, received_kg',
'transfers: transfer_ref, from_code, to_code, transfer_date, status · transfer_lines: transfer_ref, product_sku, sent_packs, received_packs, kind',
'count_sessions: count_ref, location_code, count_date, status · count_lines: count_ref, ref_sku, book_qty, counted_qty, kind',
'mrp_plans: plan_date, ref, saved_at, data (json) · demand: sku, plan_date, qty, source',
'shopify_inventory: sku, location_name, available, on_hand, fetched_at · sales_momentum: sku, product, u30, u60, u90, refreshed_at',
'shopify_events: occurred_at, variant_sku, qty, event_type, posted, post_error, order_name',
'inventory_movements: created_at, kind, ref_sku, location_code, qty, movement_type, note, source_ref · stock_balance: location_code, kind, ref_sku, on_hand',
'',
'QUERY TIPS. Use select to name only the columns you need. Filters use PostgREST form, e.g. status=eq.open, product_sku=eq.CUST-JAIRUS-CHICHI-66, order_ref=in.(CO-1,CO-2), production_date=gte.2026-10-01, customer_name=ilike.*jairus*. Keep limit small. For a JSON column use select=data->demand.'
].join('\n');

/* ================================== plumbing ================================== */
function P(k){ return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function tg(method, payload){
  return UrlFetchApp.fetch('https://api.telegram.org/bot' + P('TELEGRAM_BOT_TOKEN') + '/' + method, {
    method:'post', contentType:'application/json', muteHttpExceptions:true, payload: JSON.stringify(payload) });
}
function send(chatId, text, extra){
  var chunks = String(text || '').match(/[\s\S]{1,3800}/g) || [''];
  chunks.forEach(function(c, i){
    var p = { chat_id: chatId, text: c, disable_web_page_preview: true };
    if (extra && i === chunks.length - 1) for (var k in extra) p[k] = extra[k];
    tg('sendMessage', p);
  });
}
function sbGet(path){
  var key = P('WR_SERVICE_ROLE');
  var r = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/' + path, { method:'get', muteHttpExceptions:true,
    headers:{ apikey:key, Authorization:'Bearer ' + key } });
  return { code: r.getResponseCode(), text: r.getContentText() };
}
/* The ONLY write the bot makes, and only to its own log table. */
function logRow(row){
  var key = P('WR_SERVICE_ROLE');
  var r = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/erp_bot_log?select=id', { method:'post', muteHttpExceptions:true,
    contentType:'application/json', headers:{ apikey:key, Authorization:'Bearer ' + key, Prefer:'return=representation' },
    payload: JSON.stringify(row) });
  try { return (JSON.parse(r.getContentText()) || [])[0] || null; } catch (e) { return null; }
}
function logPatch(id, fields){
  var key = P('WR_SERVICE_ROLE');
  UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/erp_bot_log?id=eq.' + encodeURIComponent(id), { method:'patch', muteHttpExceptions:true,
    contentType:'application/json', headers:{ apikey:key, Authorization:'Bearer ' + key, Prefer:'return=minimal' },
    payload: JSON.stringify(fields) });
}

/* =============================== the query tool =============================== */
var FILTER_RE = /^[a-z_][a-z0-9_]*(->>?[a-z0-9_]+)?=(not\.)?(eq|neq|gt|gte|lt|lte|like|ilike|in|is)\.[^&]{0,300}$/i;
function runQuery(input, isOwner){
  var t = String(input.table || '');
  if (!READABLE[t]) return { error: 'table not allowed: ' + t };
  var filters = (input.filters || []).map(String);
  for (var i = 0; i < filters.length; i++) if (!FILTER_RE.test(filters[i])) return { error: 'bad filter: ' + filters[i] };
  if (MUST_FILTER[t] && !filters.length) return { error: t + ' is large — add at least one filter (e.g. a sku, ref or date)' };
  var limit = Math.max(1, Math.min(200, +input.limit || 50));
  var sel = String(input.select || '*').replace(/[^a-zA-Z0-9_,*>\-]/g, '');
  var path = t + '?select=' + encodeURIComponent(sel) + (filters.length ? '&' + filters.map(function(f){
    var i = f.indexOf('='); return f.slice(0, i) + '=' + encodeURIComponent(f.slice(i + 1)); }).join('&') : '')
    + (input.order ? '&order=' + encodeURIComponent(String(input.order).replace(/[^a-z0-9_.,]/gi, '')) : '')
    + '&limit=' + limit;
  var r = sbGet(path);
  if (r.code >= 300) return { error: 'HTTP ' + r.code + ' ' + r.text.slice(0, 300) };
  var rows = []; try { rows = JSON.parse(r.text) || []; } catch (e) {}
  if (!isOwner) rows = rows.map(function(o){ var c = {}; for (var k in o) if (!MONEY_COL.test(k)) c[k] = o[k]; return c; });
  var out = JSON.stringify(rows);
  if (out.length > 30000) out = out.slice(0, 30000) + ' …(cut — narrow the query)';
  return { rows: rows.length, data: out };
}

/* ================================ the code tool ================================
   The repo is public, so the code is read from GitHub's raw file address (no token
   needed). index.html is ~2.3 MB: it is fetched, searched here, and only the matching
   lines go to Claude — a few thousand characters, not the whole file.            */
function searchCode_(input){
  var repo = P('GITHUB_REPO') || 'mickomangalindan/WR-Inventory';
  var file = String(input.file || 'index.html').replace(/[^A-Za-z0-9_./-]/g, '').replace(/\.\./g, '');
  var ctx = Math.max(0, Math.min(15, input.context == null ? 6 : +input.context));
  var r = UrlFetchApp.fetch('https://raw.githubusercontent.com/' + repo + '/main/' + file, { muteHttpExceptions:true });
  if (r.getResponseCode() >= 300) return { error: 'could not read ' + file + ' (HTTP ' + r.getResponseCode() + ')' };
  var lines = r.getContentText().split('\n'), re;
  try { re = new RegExp(String(input.pattern || ''), 'i'); } catch (e) { re = new RegExp(String(input.pattern || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  var hits = [];
  for (var i = 0; i < lines.length && hits.length < 8; i++) if (re.test(lines[i])) hits.push(i);
  if (!hits.length) return { matches: 0, note: 'no line in ' + file + ' matches ' + input.pattern };
  var out = [], used = {};
  hits.forEach(function(h){
    for (var k = Math.max(0, h - ctx); k <= Math.min(lines.length - 1, h + ctx); k++) {
      if (used[k]) continue; used[k] = 1; out.push((k + 1) + ': ' + lines[k].slice(0, 240)); }
    out.push('---');
  });
  var txt = out.join('\n'); if (txt.length > 9000) txt = txt.slice(0, 9000) + '\n…(cut — search more narrowly)';
  return { file: file, matches: hits.length, lines_total: lines.length, code: txt };
}

var TOOLS = [
  { name:'query', description:'Read rows from one ERP table (read-only). Returns JSON rows.',
    input_schema:{ type:'object', properties:{
      table:{ type:'string', description:'one of: ' + Object.keys(READABLE).join(', ') },
      select:{ type:'string', description:'columns, comma separated (default *)' },
      filters:{ type:'array', items:{ type:'string' }, description:'PostgREST filters like status=eq.open' },
      order:{ type:'string', description:'e.g. created_at.desc' },
      limit:{ type:'integer', description:'max rows, up to 200' } }, required:['table'] } },
  { name:'search_code', description:'Search the ERP app code (index.html on GitHub) and any Apps Script files kept in the repo. Returns matching lines with line numbers and a little context. Use it to explain WHY the app does something, or whether a fix is in the code.',
    input_schema:{ type:'object', properties:{
      pattern:{ type:'string', description:'text or simple regex to find, e.g. function mrpSetDem or DEM_MIN' },
      file:{ type:'string', description:'optional: index.html (default) or a path like apps-script/wr-erp-automations.gs' },
      context:{ type:'integer', description:'lines of context around each match, 0-15 (default 6)' } }, required:['pattern'] } },
  { name:'propose_fix', description:'File a fix for Zeus to approve when the data or the app looks wrong. Do not use for questions.',
    input_schema:{ type:'object', properties:{
      title:{ type:'string', description:'short title' },
      problem:{ type:'string', description:'what is wrong, in plain words' },
      evidence:{ type:'string', description:'the rows / numbers you saw' },
      suggested_fix:{ type:'string', description:'what should change' } }, required:['title','problem','evidence'] } }
];

/* ================================ Claude call ================================= */
function claude(messages, noTools){
  var model = P('CLAUDE_MODEL') || 'claude-haiku-5-5';
  var r = UrlFetchApp.fetch(ANTHROPIC_URL, { method:'post', muteHttpExceptions:true, contentType:'application/json',
    headers:{ 'x-api-key': P('ANTHROPIC_API_KEY'), 'anthropic-version':'2023-06-01' },
    payload: JSON.stringify({ model: model, max_tokens: 2000,
      system:[{ type:'text', text: PRIMER, cache_control:{ type:'ephemeral' } }],
      tools: TOOLS, tool_choice: noTools ? { type:'none' } : { type:'auto' }, messages: messages }) });
  var body = {}; try { body = JSON.parse(r.getContentText()); } catch (e) {}
  if (r.getResponseCode() >= 300) throw new Error('Claude API ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 300));
  body._model = model; return body;
}
function costOf(model, u){
  var p = PRICES[model] || PRICES['claude-haiku-5-5'];
  return ((u.input_tokens||0)*p[0] + (u.output_tokens||0)*p[1] + (u.cache_read_input_tokens||0)*p[2]
        + (u.cache_creation_input_tokens||0)*p[3]) / 1e6;
}

/* Answer one question. Returns { text, fixes:[], usage, model, cost }. */
function answer(question, who, isOwner){
  var messages = [{ role:'user', content: 'Asked by ' + who + (isOwner ? ' (owner — may see costs)' : '') + ':\n' + question }];
  var tot = { input_tokens:0, output_tokens:0, cache_read_input_tokens:0, cache_creation_input_tokens:0 }, model = '', fixes = [];
  for (var round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    /* THE LAST ROUND MUST ANSWER. A big multi-part question (2 Nov: "review this
       6-step flow") used every lookup and came back with no words at all, shown as
       "(no answer)". Now the final round is not allowed to look anything up: it
       answers from what it has found, and says what it could not check. */
    var last = round === MAX_TOOL_ROUNDS;
    if (last) {
      var nudge = { type:'text', text:'You have used all your lookups. Answer now from what you found. If some part could not be checked, say which part and which screen to look at.' };
      var prev = messages[messages.length - 1];
      if (prev && prev.role === 'user' && Array.isArray(prev.content)) prev.content.push(nudge);   // keep user/assistant turns alternating
      else messages.push({ role:'user', content: [nudge] });
    }
    var res = claude(messages, last); model = res._model;
    var u = res.usage || {}; for (var k in tot) tot[k] += (u[k] || 0);
    var content = res.content || [];
    if (res.stop_reason !== 'tool_use' || round === MAX_TOOL_ROUNDS) {
      var text = content.filter(function(b){ return b.type === 'text'; }).map(function(b){ return b.text; }).join('\n').trim();
      return { text: text || '(no answer)', fixes: fixes, usage: tot, model: model, cost: costOf(model, tot) };
    }
    messages.push({ role:'assistant', content: content });
    var results = [];
    content.forEach(function(b){
      if (b.type !== 'tool_use') return;
      var out;
      if (b.name === 'query') out = runQuery(b.input || {}, isOwner);
      else if (b.name === 'search_code') out = searchCode_(b.input || {});
      else if (b.name === 'propose_fix') { fixes.push(b.input || {}); out = { filed: true, note: 'Zeus will be asked to approve.' }; }
      else out = { error: 'unknown tool' };
      results.push({ type:'tool_result', tool_use_id: b.id, content: JSON.stringify(out) });
    });
    messages.push({ role:'user', content: results });
  }
}

/* ================================ Telegram in ================================= */
function doGet(){ return ContentService.createTextOutput('WR ERP bot: up'); }

function doPost(e){
  try {
    var u = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    /* Telegram retries when Apps Script answers with its usual redirect, so the same
       update can arrive twice. Answer each update once. */
    var cache = CacheService.getScriptCache();
    if (u.update_id != null) { if (cache.get('u' + u.update_id)) return ok_(); cache.put('u' + u.update_id, '1', 21600); }
    if (u.callback_query) return onButton_(u.callback_query);
    if (u.message) onMessage_(u.message);
  } catch (err) { console.error(err); }
  return ok_();
}
function ok_(){ return ContentService.createTextOutput('ok'); }

/* ---- POLLING (the reliable way on Apps Script) --------------------------------
   An Apps Script web app answers every POST with a redirect, and Telegram reads a
   redirect as a failed delivery: it retries the same message and backs off, so the
   NEXT question can sit unanswered for minutes. That is what happened on 2 Nov
   ("the first question went through, the next one doesn't respond").
   Polling avoids it: a 1-minute trigger asks Telegram for new messages. Answers
   arrive within about a minute, every time. Run installPolling() once.          */
function pollUpdates(){
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;                 // the previous run is still answering
  try {
    var props = PropertiesService.getScriptProperties();
    var offset = +(props.getProperty('OFFSET') || 0);
    var r = tg('getUpdates', { offset: offset, timeout: 0, limit: 20, allowed_updates: ['message', 'callback_query'] });
    var j = {}; try { j = JSON.parse(r.getContentText()); } catch (e) {}
    (j.result || []).forEach(function(u){
      props.setProperty('OFFSET', String(u.update_id + 1));   // move on first, so one bad message cannot block the rest
      /* Same "answer each update once" check as doPost: an update the old webhook
         already answered can still be handed over once when switching to polling. */
      var cache = CacheService.getScriptCache();
      if (cache.get('u' + u.update_id)) return;
      cache.put('u' + u.update_id, '1', 21600);
      try {
        if (u.callback_query) onButton_(u.callback_query);
        else if (u.message) onMessage_(u.message);
      } catch (err) { console.error(err); }
    });
  } finally { lock.releaseLock(); }
}
function installPolling(){
  tg('deleteWebhook', { drop_pending_updates: false });   // getUpdates refuses while a webhook is set
  ScriptApp.getProjectTriggers().forEach(function(t){ if (t.getHandlerFunction() === 'pollUpdates') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('pollUpdates').timeBased().everyMinutes(1).create();
  Logger.log('Polling every minute. Webhook removed. Messages waiting: ' + tg('getWebhookInfo', {}).getContentText());
}
function webhookInfo(){ Logger.log(tg('getWebhookInfo', {}).getContentText()); }

function onMessage_(m){
  var chatId = String(m.chat.id), text = String(m.text || '');
  if (!text) return;
  var allowed = P('ALLOWED_CHAT_IDS').split(',').map(function(s){ return s.trim(); }).filter(String);
  var owner = P('OWNER_USER_ID'), fromId = String((m.from || {}).id || '');
  var isOwner = !!owner && fromId === owner;
  if (allowed.indexOf(chatId) < 0 && !isOwner) return;           // strangers get silence

  var botName = P('BOT_USERNAME'), isPrivate = m.chat.type === 'private';
  var mentioned = botName && text.toLowerCase().indexOf('@' + botName.toLowerCase()) >= 0;
  var replyToBot = m.reply_to_message && m.reply_to_message.from && m.reply_to_message.from.username === botName;
  if (!isPrivate && !mentioned && !replyToBot) return;

  var q = botName ? text.replace(new RegExp('@' + botName, 'ig'), '').trim() : text;
  var props0 = PropertiesService.getScriptProperties();
  if (isOwner && /^\/pause\b/i.test(q)) { props0.setProperty('PAUSED', '1'); return send(chatId, '⏸ Paused. Nobody gets answers until you send /resume.'); }
  if (isOwner && /^\/resume\b/i.test(q)) { props0.deleteProperty('PAUSED'); return send(chatId, '▶ Resumed.'); }
  if (isOwner && /^\/usage\b/i.test(q)) return usage_(chatId);
  if (isOwner && /^\/prs\b/i.test(q)) return checkPRs(true);
  if (/^\/fixes\b/i.test(q) && isOwner) return listFixes_(chatId);
  if (props0.getProperty('PAUSED') && !isOwner) return send(chatId, 'I am paused right now. Ask Zeus.');
  if (/^\/(start|help)\b/i.test(q)) return send(chatId, 'Ask me anything about the ERP: orders, stock, plots, POs, production. Example: "what is still owed on CO-10202026 V01?" I only read — fixes go to Zeus for approval.');
  if (replyToBot && m.reply_to_message.text) q = 'Earlier you said: "' + m.reply_to_message.text.slice(0, 1500) + '"\nFollow-up: ' + q;

  var day = Utilities.formatDate(new Date(), 'Asia/Manila', 'yyyyMMdd'), props = PropertiesService.getScriptProperties();
  var n = +(props.getProperty('N' + day) || 0), cap = +(P('DAILY_LIMIT') || 60);
  if (n >= cap && !isOwner) return send(chatId, 'I have answered ' + cap + ' questions today — that is my daily limit. Try again tomorrow, or ask Zeus.');
  var hr = Utilities.formatDate(new Date(), 'Asia/Manila', 'yyyyMMddHH'), uk = 'U' + fromId + '_' + hr;
  var un = +(props.getProperty(uk) || 0), ucap = +(P('USER_HOURLY') || 10);
  if (un >= ucap && !isOwner) return send(chatId, 'That is ' + ucap + ' questions from you this hour — give me a break and try again later.');
  var spent = +(props.getProperty('USD' + day) || 0), usdCap = +(P('DAILY_USD') || 1.5);
  if (spent >= usdCap) {
    if (!props.getProperty('CAPHIT' + day)) { props.setProperty('CAPHIT' + day, '1'); if (owner) send(owner, '⚠ The ERP bot hit today\'s spend cap ($' + usdCap + ') and stopped answering. It restarts tomorrow. Raise DAILY_USD or send /resume tomorrow if needed.'); }
    return send(chatId, 'I have used up today\'s budget. I will be back tomorrow.');
  }
  props.setProperty('N' + day, String(n + 1)); props.setProperty(uk, String(un + 1));

  var who = [m.from.first_name, m.from.last_name].filter(String).join(' ') + (m.from.username ? ' (@' + m.from.username + ')' : '');
  tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  var a;
  try { a = answer(q, who, isOwner); }
  catch (err) { send(chatId, 'Sorry, I could not answer that just now (' + String(err.message || err).slice(0, 120) + ').'); return; }

  props.setProperty('USD' + day, String((+(props.getProperty('USD' + day) || 0)) + a.cost));
  send(chatId, a.text + (isOwner ? '\n\n— ' + a.model + ' · $' + a.cost.toFixed(4) : ''), { reply_to_message_id: m.message_id });
  logRow({ kind:'question', chat_id: chatId, asked_by: who, asked_by_id: fromId, question: q, answer: a.text,
           model: a.model, tokens_in: a.usage.input_tokens + a.usage.cache_read_input_tokens + a.usage.cache_creation_input_tokens,
           tokens_out: a.usage.output_tokens, cost_usd: Math.round(a.cost * 1e5) / 1e5 });

  a.fixes.forEach(function(f){
    var detail = 'Problem: ' + (f.problem || '') + '\nEvidence: ' + (f.evidence || '') + '\nSuggested fix: ' + (f.suggested_fix || '(none)') + '\nFrom a question by ' + who + ': ' + q;
    var row = logRow({ kind:'fix', chat_id: chatId, asked_by: who, asked_by_id: fromId, question: q, fix_title: f.title || 'Fix', fix_detail: detail, status:'pending', model: a.model });
    if (owner && row && row.id) send(owner, '🛠 Fix proposal #' + row.id + ' — ' + (f.title || '') + '\n\n' + detail, {
      reply_markup: { inline_keyboard: [[ { text:'✅ Approve', callback_data:'ok:' + row.id }, { text:'❌ Reject', callback_data:'no:' + row.id } ]] } });
  });
}

function onButton_(cb){
  var owner = P('OWNER_USER_ID');
  if (String(cb.from.id) !== owner) { tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Only Zeus can decide fixes.' }); return ok_(); }
  var pm = /^(merge|close):(\d+)$/.exec(String(cb.data || ''));
  if (pm) return prButton_(cb, pm[1], pm[2]);
  var mm = /^(ok|no):(\d+)$/.exec(String(cb.data || ''));
  if (!mm) return ok_();
  var status = mm[1] === 'ok' ? 'approved' : 'rejected';
  logPatch(mm[2], { status: status, decided_by: cb.from.username || String(cb.from.id), decided_at: new Date().toISOString() });
  tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Fix #' + mm[2] + ' ' + status });
  tg('editMessageReplyMarkup', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
  send(cb.message.chat.id, status === 'approved'
    ? 'Fix #' + mm[2] + ' approved. Bring it to the Claude project ("do the approved bot fixes") and it will be built, tested and handed to you to deploy.'
    : 'Fix #' + mm[2] + ' rejected.');
  return ok_();
}

function listFixes_(chatId){
  var r = sbGet('erp_bot_log?select=id,created_at,fix_title,status&kind=eq.fix&status=in.(pending,approved)&order=id.desc&limit=20');
  var rows = []; try { rows = JSON.parse(r.text) || []; } catch (e) {}
  send(chatId, rows.length ? rows.map(function(x){ return '#' + x.id + ' · ' + x.status + ' · ' + String(x.created_at).slice(0,10) + ' · ' + x.fix_title; }).join('\n')
                           : 'No pending or approved fixes.');
}

/* ============================ spend report (owner) ============================ */
function usage_(chatId){
  var r = sbGet('erp_bot_log?select=created_at,cost_usd&created_at=gte.' + encodeURIComponent(new Date(Date.now() - 31*864e5).toISOString()) + '&limit=5000');
  var rows = []; try { rows = JSON.parse(r.text) || []; } catch (e) {}
  var today = Utilities.formatDate(new Date(), 'Asia/Manila', 'yyyy-MM-dd'), d = 0, m = 0, nd = 0;
  rows.forEach(function(x){ var c = +x.cost_usd || 0; m += c; if (Utilities.formatDate(new Date(x.created_at), 'Asia/Manila', 'yyyy-MM-dd') === today) { d += c; nd++; } });
  send(chatId, 'Spend today: $' + d.toFixed(3) + ' (' + nd + ' answers)\nLast 31 days: $' + m.toFixed(2) + ' of the $100 monthly credit\n'
    + 'Caps: ' + (P('DAILY_USD') || 1.5) + ' $/day · ' + (P('DAILY_LIMIT') || 60) + ' questions/day · ' + (P('USER_HOURLY') || 10) + ' per person/hour'
    + (P('PAUSED') ? '\nStatus: ⏸ paused' : '\nStatus: ▶ running'));
}

/* ================ Claude's fixes → merge from Telegram (GitHub) ================
 * Claude builds a fix in the claude.ai project and opens a pull request on WR-Inventory.
 * checkPRs() runs every 15 minutes, tells you about each new one, with Merge / Close.
 * Merging is what publishes the site (GitHub Pages builds from main). Only the owner
 * can press the buttons. SQL that comes with a fix is shown in the PR description —
 * the bot never runs SQL.                                                          */
function gh_(method, path, body){
  var r = UrlFetchApp.fetch('https://api.github.com/repos/' + (P('GITHUB_REPO') || 'mickomangalindan/WR-Inventory') + path, {
    method: method, muteHttpExceptions: true, contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + P('GITHUB_TOKEN'), Accept: 'application/vnd.github+json' },
    payload: body ? JSON.stringify(body) : undefined });
  var j = null; try { j = JSON.parse(r.getContentText()); } catch (e) {}
  return { code: r.getResponseCode(), json: j };
}
function checkPRs(all){
  var owner = P('OWNER_USER_ID'); if (!P('GITHUB_TOKEN') || !owner) return;
  var r = gh_('get', '/pulls?state=open&per_page=20');
  if (r.code >= 300 || !r.json) { if (all) send(owner, 'GitHub said ' + r.code + ' — check GITHUB_TOKEN.'); return; }
  var props = PropertiesService.getScriptProperties();
  if (all && !r.json.length) send(owner, 'No open pull requests.');
  r.json.forEach(function(pr){
    if (!all && props.getProperty('PR' + pr.number)) return;
    props.setProperty('PR' + pr.number, '1');
    var body = String(pr.body || '').slice(0, 2500);
    send(owner, '🔧 Fix ready to publish — PR #' + pr.number + ': ' + pr.title + '\n\n' + body + '\n\n' + pr.html_url, {
      reply_markup: { inline_keyboard: [[ { text:'🚀 Merge (goes live)', callback_data:'merge:' + pr.number }, { text:'✖ Close', callback_data:'close:' + pr.number } ]] } });
  });
}
function prButton_(cb, act, num){
  tg('answerCallbackQuery', { callback_query_id: cb.id, text: act === 'merge' ? 'Merging…' : 'Closing…' });
  var r = act === 'merge' ? gh_('put', '/pulls/' + num + '/merge', { merge_method: 'squash' })
                          : gh_('patch', '/pulls/' + num, { state: 'closed' });
  tg('editMessageReplyMarkup', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
  var okd = r.code < 300;
  send(cb.message.chat.id, okd ? (act === 'merge' ? '✅ PR #' + num + ' merged. The site updates in about a minute — hard-refresh the app.' : 'PR #' + num + ' closed.')
                              : '⚠ GitHub refused (' + r.code + '): ' + JSON.stringify(r.json || {}).slice(0, 200));
  return ok_();
}
function installPRWatcher(){
  ScriptApp.getProjectTriggers().forEach(function(t){ if (t.getHandlerFunction() === 'checkPRs') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('checkPRs').timeBased().everyMinutes(15).create();
  Logger.log('PR watcher: every 15 minutes.');
}

/* ================================== setup ===================================== */
function setWebhook(){
  var url = P('WEBHOOK_URL'); if (!url) throw new Error('Set WEBHOOK_URL (the deployed /exec URL) first');
  var r = tg('setWebhook', { url: url, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
  Logger.log(r.getContentText());
}
function selfTest(){
  ['TELEGRAM_BOT_TOKEN','BOT_USERNAME','ANTHROPIC_API_KEY','WR_SERVICE_ROLE','OWNER_USER_ID','ALLOWED_CHAT_IDS']
    .forEach(function(k){ Logger.log((P(k) ? 'ok   ' : 'MISSING ') + k); });
  Logger.log('Telegram: ' + tg('getMe', {}).getContentText().slice(0, 200));
  Logger.log('Webhook (should be empty url when polling):  ' + tg('getWebhookInfo', {}).getContentText().slice(0, 300));
  Logger.log('Polling trigger: ' + (ScriptApp.getProjectTriggers().some(function(t){ return t.getHandlerFunction() === 'pollUpdates'; }) ? 'ok' : 'MISSING — run installPolling()'));
  Logger.log('Supabase: ' + sbGet('erp_bot_log?select=id&limit=1').code + ' (200 = log table ready)');
  var a = answer('How many custom orders are open right now? One line.', 'selfTest', true);
  Logger.log('Claude:   ' + a.text + '  [' + a.model + ' $' + a.cost.toFixed(4) + ']');
}
